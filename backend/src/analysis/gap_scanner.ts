import axios from "axios";
import { db } from "../../db/src";
import { overnightWatchlistTable } from "../../db/src";
import { eq, and } from "drizzle-orm";
import { getAccessToken } from "../upstox/auth";
import { NSE_UNIVERSE } from "./stock_scanner";
import { logger } from "../lib/logger";
import { getISTDateStr } from "../lib/ist-time";

interface GapResult {
  symbol: string;
  name: string;
  prevClose: number;
  gapPct: number; // positive = gap up, negative = gap down
  category: "GAP_UP" | "GAP_DOWN";
  condition: string;
  priority: number;
}

/** Fetch the most recent completed closing price for a single instrument. */
async function fetchPrevClose(
  instrumentKey: string,
  token: string,
): Promise<number | null> {
  try {
    const today = getISTDateStr();
    const from = new Date(Date.now() + 330 * 60 * 1000);
    from.setUTCDate(from.getUTCDate() - 7); // look back 7 days to skip holidays
    const fromStr = from.toISOString().split("T")[0]!;

    const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/day/${today}/${fromStr}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 6000,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candles = (resp.data?.data?.candles ?? []) as any[][];
    if (!candles.length) return null;

    // Upstox returns newest-first. If market is open, the first candle may be today's in-progress bar.
    const completedCandle =
      candles.find(
        (c) =>
          typeof c[0] === "string" && (c[0] as string).split("T")[0] !== today,
      ) ?? candles[0];
    return (completedCandle?.[4] as number) ?? null;
  } catch {
    return null;
  }
}

/** Fetch intraday LTP to estimate current pre-market price. */
async function fetchLTP(
  instrumentKeys: string[],
  token: string,
): Promise<Record<string, number>> {
  try {
    const joined = instrumentKeys.slice(0, 50).join(","); // API limit
    const url = `https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent(joined)}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 8000,
    });

    const data: Record<string, { last_price?: number }> = resp.data?.data ?? {};
    const result: Record<string, number> = {};
    for (const [key, val] of Object.entries(data)) {
      if (val.last_price) result[key] = val.last_price;
    }
    return result;
  } catch {
    return {};
  }
}

export async function runGapScan(forDate?: string): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    logger.warn("Gap scan skipped — Upstox not authenticated");
    return;
  }

  const targetDate = forDate ?? getISTDateStr();
  logger.info({ date: targetDate }, "Starting pre-market gap scan");

  // Step 1: Fetch prev close for all universe stocks (batched)
  const prevCloses: Record<string, { close: number; name: string }> = {};
  const batchSize = 4;
  const stocks = [...NSE_UNIVERSE];

  for (let i = 0; i < stocks.length; i += batchSize) {
    const chunk = stocks.slice(i, i + batchSize);
    await Promise.all(
      chunk.map(async (s) => {
        const close = await fetchPrevClose(s.key, token);
        if (close != null) prevCloses[s.symbol] = { close, name: s.name };
      }),
    );
    if (i + batchSize < stocks.length) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Step 2: Fetch LTP for all universe stocks (batched — API accepts max 50 keys)
  const ltpBySymbol: Record<string, number> = {};
  for (let i = 0; i < stocks.length; i += 50) {
    const batchKeys = stocks.slice(i, i + 50).map((s) => s.key);
    const ltpMap = await fetchLTP(batchKeys, token);
    for (const s of stocks.slice(i, i + 50)) {
      const ltp = ltpMap[s.key];
      if (ltp != null) ltpBySymbol[s.symbol] = ltp;
    }
    if (i + 50 < stocks.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Step 3: Calculate gaps
  const gaps: GapResult[] = [];
  for (const s of stocks) {
    const prev = prevCloses[s.symbol];
    const ltp = ltpBySymbol[s.symbol];
    if (!prev || !ltp) continue;

    const gapPct = ((ltp - prev.close) / prev.close) * 100;
    if (Math.abs(gapPct) < 1.5) continue; // Only significant gaps

    const direction = gapPct > 0 ? "GAP_UP" : "GAP_DOWN";
    const absGap = Math.abs(gapPct);

    let condition: string;
    let priority: number;

    if (absGap >= 4) {
      condition = `Gap ${gapPct > 0 ? "up" : "down"} ${absGap.toFixed(1)}% vs prev close ₹${prev.close.toFixed(0)} — major gap, await fill or continuation`;
      priority = 10;
    } else if (absGap >= 2.5) {
      condition = `Gap ${gapPct > 0 ? "up" : "down"} ${absGap.toFixed(1)}% from ₹${prev.close.toFixed(0)} — watch first 15 min for direction`;
      priority = 7;
    } else {
      condition = `Gap ${gapPct > 0 ? "up" : "down"} ${absGap.toFixed(1)}% — minor gap, likely fills within first hour`;
      priority = 4;
    }

    gaps.push({
      symbol: s.symbol,
      name: s.name,
      prevClose: prev.close,
      gapPct,
      category: direction,
      condition,
      priority,
    });
  }

  // Sort by absolute gap size, take top 20
  const topGaps = gaps
    .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
    .slice(0, 20);

  if (topGaps.length === 0) {
    logger.info("Gap scan complete — no significant gaps found");
    return;
  }

  const rows = topGaps.map((g) => ({
    forDate: targetDate,
    symbol: g.symbol,
    name: g.name,
    category: "GAP_CANDIDATE" as const,
    condition: g.condition,
    priority: g.priority,
  }));

  // Only delete existing GAP_CANDIDATE entries for this date, preserving
  // overnight scanner and intraday enrichment results.
  await db.transaction(async (tx) => {
    await tx
      .delete(overnightWatchlistTable)
      .where(
        and(
          eq(overnightWatchlistTable.forDate, targetDate),
          eq(overnightWatchlistTable.category, "GAP_CANDIDATE"),
        ),
      );
    await tx.insert(overnightWatchlistTable).values(rows);
  });

  logger.info(
    { date: targetDate, gaps: topGaps.length, biggest: topGaps[0]?.symbol },
    "Gap scan complete",
  );
}
