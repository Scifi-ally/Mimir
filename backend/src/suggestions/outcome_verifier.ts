import { db, suggestionsTable } from "../../db/src";
import { and, eq, inArray, isNull, isNotNull, lte } from "drizzle-orm";
import { logger } from "../lib/logger";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { createUpstoxClient } from "../lib/upstox-client";
import { getAccessToken } from "../upstox/auth";
import { findStockBySymbol } from "../analysis/stock_scanner";
import { getISTDateStr } from "../lib/ist-time";

// Dedicated client: outcome verification runs off the hot path, so a longer
// candle cache is fine and keeps us from re-hitting Upstox for the same window.
const verifierClient = createUpstoxClient({ cacheTimeMs: 10 * 60 * 1000 });

// Same flat round-trip cost model as accuracy_tracker.netPnl, duplicated here to
// avoid importing the polling module (which pulls in the tick distribution).
const COST_RATE_PER_SIDE = 0.0005;
function netPnl(entry: number, exit: number, qty: number, gross: number): number {
  const costs = (entry + exit) * qty * COST_RATE_PER_SIDE;
  return gross - costs;
}

interface Candle {
  ts: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Replay 1-minute candles over [notBefore, expiresAt] and return which exit
 * level was touched FIRST. Within a single candle the stop is assumed hit
 * before the target — the same pessimistic convention the live tracker uses
 * when one print crosses both. Returns null when no level was touched in the
 * window (the trade genuinely expired open).
 */
function firstTouchFromCandles(
  direction: string,
  candles: Candle[],
  stop: number,
  t1: number,
  t2: number | null,
): { level: "STOP" | "T1" | "T2"; price: number } | null {
  for (const c of candles) {
    if (direction === "BUY") {
      if (c.low <= stop) return { level: "STOP", price: stop };
      if (t2 != null && c.high >= t2) return { level: "T2", price: t2 };
      if (c.high >= t1) return { level: "T1", price: t1 };
    } else {
      if (c.high >= stop) return { level: "STOP", price: stop };
      if (t2 != null && c.low <= t2) return { level: "T2", price: t2 };
      if (c.low <= t1) return { level: "T1", price: t1 };
    }
  }
  return null;
}

function toCandles(raw: unknown[][]): Candle[] {
  // Upstox candle shape: [timestamp, open, high, low, close, volume, oi].
  const out: Candle[] = [];
  for (const row of raw) {
    const ts = new Date(String(row[0])).getTime();
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    if (!Number.isFinite(ts) || !Number.isFinite(high) || !Number.isFinite(low)) continue;
    out.push({ ts, high, low, close });
  }
  // Upstox returns newest-first; replay must be chronological.
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Backfill verified outcomes for closed suggestions whose live tracker never
 * assigned a P&L (the "OUTCOME ₹— / P&L —" rows). For each such row we pull the
 * 1-minute candles that cover its allotted window and decide the true result:
 * which of stop / target-1 / target-2 was touched first, or a mark-to-window-
 * close exit if none was. Rows are stamped `outcomeVerifiedAt` so we only ever
 * process each once.
 *
 * MISSED rows are intentionally skipped: their entry was never touched, so no
 * trade existed and P&L is correctly null.
 */
export async function verifyExpiredOutcomes(limit = 50): Promise<number> {
  const token = getAccessToken();
  if (!token) {
    logger.warn("Outcome verifier: no Upstox access token, skipping");
    return 0;
  }

  let rows: (typeof suggestionsTable.$inferSelect)[];
  try {
    rows = await db
      .select()
      .from(suggestionsTable)
      .where(
        and(
          inArray(suggestionsTable.status, ["EXPIRED", "CLOSED"]),
          isNull(suggestionsTable.outcomeVerifiedAt),
          isNull(suggestionsTable.pnlInr),
          isNotNull(suggestionsTable.expiresAt),
          lte(suggestionsTable.expiresAt, new Date()),
        ),
      )
      .limit(limit);
  } catch (err) {
    logger.error({ err }, "Outcome verifier: failed to load unverified suggestions");
    return 0;
  }

  if (rows.length === 0) return 0;

  let verified = 0;
  for (const row of rows) {
    try {
      const stock = await findStockBySymbol(row.symbol);
      if (!stock?.key) {
        logger.warn({ symbol: row.symbol }, "Outcome verifier: no instrument key, skipping");
        continue;
      }

      const generatedAtMs = new Date(row.generatedAt).getTime();
      const expiresAtMs = row.expiresAt ? new Date(row.expiresAt).getTime() : Date.now();
      const fromDate = getISTDateStr(new Date(generatedAtMs));
      const toDate = getISTDateStr(new Date(expiresAtMs));

      const raw = await verifierClient.fetchHistoricalCandles(
        stock.key,
        "1minute",
        toDate,
        fromDate,
        token,
      );
      const candles = toCandles(Array.isArray(raw) ? raw : []).filter(
        (c) => c.ts >= generatedAtMs && c.ts <= expiresAtMs,
      );

      if (candles.length === 0) {
        // No candle data for the window (delisted, illiquid, or provider gap).
        // Stamp verified so we don't re-fetch forever; leave P&L null.
        await db
          .update(suggestionsTable)
          .set({ outcomeVerifiedAt: new Date() })
          .where(eq(suggestionsTable.id, row.id));
        logger.warn({ symbol: row.symbol, id: row.id }, "Outcome verifier: no candles for window");
        continue;
      }

      const entry = parseFloat(row.entryPrice);
      const stop = parseFloat(row.stopLoss);
      const t1 = parseFloat(row.target1);
      const t2 = row.target2 ? parseFloat(row.target2) : null;
      const qty = row.quantity ?? 0;
      const isBuy = row.direction === "BUY";

      const touch = firstTouchFromCandles(row.direction, candles, stop, t1, t2);

      let status: string;
      let exitPrice: number;
      if (touch) {
        exitPrice = touch.price;
        status = touch.level === "STOP" ? "STOP_HIT" : touch.level === "T2" ? "TARGET_2_HIT" : "TARGET_1_HIT";
      } else {
        // Neither level hit within the allotted window: mark to the last close.
        // This is a real (if small) realized result, not a scratch.
        exitPrice = candles[candles.length - 1].close;
        status = "EXPIRED";
      }

      const gross = isBuy ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
      const pnl = Math.round(netPnl(entry, exitPrice, qty, gross) * 100) / 100;

      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const windowHigh = Math.max(entry, ...highs).toFixed(2);
      const windowLow = Math.min(entry, ...lows).toFixed(2);

      await db
        .update(suggestionsTable)
        .set({
          status,
          outcomePrice: exitPrice.toFixed(2),
          pnlInr: pnl.toString(),
          highestPrice: windowHigh,
          lowestPrice: windowLow,
          outcomeVerifiedAt: new Date(),
          closedAt: row.closedAt ?? new Date(expiresAtMs),
        })
        .where(eq(suggestionsTable.id, row.id));

      broadcast(
        createServerEvent.suggestionUpdated({
          id: row.id,
          status,
          pnlInr: pnl,
          outcomePrice: exitPrice,
        }),
        "suggestions",
      );

      verified++;
      logger.info(
        { symbol: row.symbol, id: row.id, status, pnl, exitPrice },
        "Outcome verifier: backfilled verified outcome",
      );
    } catch (err) {
      logger.warn({ err, symbol: row.symbol, id: row.id }, "Outcome verifier: failed for suggestion");
    }
  }

  if (verified > 0) {
    logger.info({ verified, scanned: rows.length }, "Outcome verifier: pass complete");
  }
  return verified;
}
