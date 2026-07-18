import { db } from "../../db/src";
import { suggestionsTable } from "../../db/src";
import { eq, and, lt, lte, or, inArray, isNull, sql } from "drizzle-orm";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { logger } from "../lib/logger";
import { todayStartUTC } from "../lib/ist-time";

interface PriceMap {
  [symbol: string]: number;
}

// Round-trip transaction costs as fraction of traded value per side:
// brokerage + STT + exchange charges + slippage approximation for NSE intraday.
// Flat rate; replace with per-broker fee schedule if live-order accuracy needed.
const COST_RATE_PER_SIDE = 0.0005; // 0.05% per side

/** Net PnL after transaction costs on both legs. */
function netPnl(entry: number, exit: number, qty: number, gross: number): number {
  const costs = (entry + exit) * qty * COST_RATE_PER_SIDE;
  return gross - costs;
}

/**
 * Check outcomes for all active suggestions against current prices
 * Batch database updates for efficiency
 */
export async function checkSuggestionOutcomes(prices: PriceMap): Promise<void> {
  let active: (typeof suggestionsTable.$inferSelect)[];

  try {
    active = await db
      .select()
      .from(suggestionsTable)
      .where(inArray(suggestionsTable.status, ["ACTIVE", "PENDING"]));
  } catch (err) {
    logger.error(
      { err },
      "Failed to fetch active suggestions for outcome check",
    );
    return;
  }

  if (active.length === 0) return;

  // Filter suggestions with price updates and collect outcomes
  const outcomes: Array<{
    id: string;
    symbol: string;
    status: string;
    outcomePrice: number;
    pnlInr: number | null;
  }> = [];
  const promotions: Array<{ id: string; fillPrice: number }> = [];

  for (const suggestion of active) {
    const price = prices[suggestion.symbol];
    if (price == null) continue;

    const entry = parseFloat(suggestion.entryPrice);
    const stop = parseFloat(suggestion.stopLoss);
    const t1 = parseFloat(suggestion.target1);
    const t2 = suggestion.target2 ? parseFloat(suggestion.target2) : null;
    const qty = suggestion.quantity ?? 0;

    // PENDING = planned entry not yet reached by market. Only count the trade
    // once price actually touches entry; otherwise win/loss stats include
    // trades that never existed.
    if (suggestion.status === "PENDING") {
      const touched =
        suggestion.direction === "BUY" ? price >= entry : price <= entry;
      if (!touched) continue;

      const alreadyPastTarget =
        suggestion.direction === "BUY" ? price >= t1 : price <= t1;
      if (alreadyPastTarget) {
        // Gapped through entry AND target between polls — a real order would
        // fill near current price with no edge left. Never filled: missed trade,
        // excluded from win/loss stats (honest fill model).
        outcomes.push({
          id: suggestion.id,
          symbol: suggestion.symbol,
          status: "MISSED",
          outcomePrice: price,
          pnlInr: null,
        });
      } else {
        // Model the fill at the observed (possibly gapped) price, not the
        // planned entry — a real stop/limit trigger would fill here, so PnL
        // and MFE/MAE baselines must use it.
        const fillPrice =
          suggestion.direction === "BUY"
            ? Math.max(entry, price)
            : Math.min(entry, price);
        promotions.push({ id: suggestion.id, fillPrice });
      }
      continue;
    }

    // Track observed price range for MFE/MAE analysis and entry-touch audits.
    // Atomic GREATEST/LEAST — concurrent checkers cannot clobber each other's
    // watermarks the way read-modify-write did.
    const prevHigh = suggestion.highestPrice ? parseFloat(suggestion.highestPrice) : entry;
    const prevLow = suggestion.lowestPrice ? parseFloat(suggestion.lowestPrice) : entry;
    if (price > prevHigh || price < prevLow) {
      const p = price.toFixed(2);
      db.update(suggestionsTable)
        .set({
          highestPrice: sql`GREATEST(COALESCE(${suggestionsTable.highestPrice}, ${suggestionsTable.entryPrice}), ${p}::numeric)`,
          lowestPrice: sql`LEAST(COALESCE(${suggestionsTable.lowestPrice}, ${suggestionsTable.entryPrice}), ${p}::numeric)`,
        })
        .where(eq(suggestionsTable.id, suggestion.id))
        .catch((err) => logger.warn({ err, id: suggestion.id }, "Watermark update failed"));
    }

    let outcome: string | null = null;
    let pnl: number | null = null;

    // Stop checked before targets: on ambiguous data the pessimistic label wins.
    if (suggestion.direction === "BUY") {
      if (price <= stop) {
        outcome = "STOP_HIT";
        pnl = netPnl(entry, price, qty, (price - entry) * qty);
      } else if (t2 && price >= t2) {
        outcome = "TARGET_2_HIT";
        pnl = netPnl(entry, t2, qty, (t2 - entry) * qty);
      } else if (price >= t1) {
        outcome = "TARGET_1_HIT";
        pnl = netPnl(entry, t1, qty, (t1 - entry) * qty);
      }
    } else {
      if (price >= stop) {
        outcome = "STOP_HIT";
        pnl = netPnl(entry, price, qty, (entry - price) * qty);
      } else if (t2 && price <= t2) {
        outcome = "TARGET_2_HIT";
        pnl = netPnl(entry, t2, qty, (entry - t2) * qty);
      } else if (price <= t1) {
        outcome = "TARGET_1_HIT";
        pnl = netPnl(entry, t1, qty, (entry - t1) * qty);
      }
    }

    if (outcome) {
      outcomes.push({
        id: suggestion.id,
        symbol: suggestion.symbol,
        status: outcome,
        outcomePrice: price,
        pnlInr: pnl != null ? Math.round(pnl * 100) / 100 : null,
      });
    }
  }

  if (promotions.length > 0) {
    try {
      for (const promo of promotions) {
        // Re-seed the MFE/MAE watermarks at the fill: they were seeded with the
        // planned entry at insert, and on a gapped fill the stale seed would
        // record an adverse excursion the market never traded.
        const fill = promo.fillPrice.toFixed(2);
        await db
          .update(suggestionsTable)
          .set({ status: "ACTIVE", entryPrice: fill, highestPrice: fill, lowestPrice: fill })
          .where(eq(suggestionsTable.id, promo.id));
        // Keep UI in sync — clients show PENDING as "awaiting entry"
        broadcast(
          createServerEvent.suggestionUpdated({ id: promo.id, status: "ACTIVE" }),
          "suggestions",
        );
      }
      logger.info({ count: promotions.length }, "Promoted PENDING suggestions to ACTIVE (entry touched)");
    } catch (err) {
      logger.error({ err }, "Failed to promote PENDING suggestions");
    }
  }

  // Batch update database
  if (outcomes.length === 0) return;

  try {
    for (const outcome of outcomes) {
      await db
        .update(suggestionsTable)
        .set({
          status: outcome.status,
          outcomePrice: outcome.outcomePrice.toString(),
          pnlInr: outcome.pnlInr != null ? outcome.pnlInr.toString() : null,
          closedAt: new Date(),
        })
        .where(eq(suggestionsTable.id, outcome.id));

      // Broadcast each outcome update
      broadcast(
        createServerEvent.suggestionUpdated({
          id: outcome.id,
          status: outcome.status as
            | "TARGET_1_HIT"
            | "TARGET_2_HIT"
            | "STOP_HIT"
            | "EXPIRED"
            | "MISSED",
          pnlInr: outcome.pnlInr,
          outcomePrice: outcome.outcomePrice,
        }),
        "suggestions"
      );

      logger.info(
        { symbol: outcome.symbol, status: outcome.status, pnl: outcome.pnlInr },
        "Suggestion outcome updated",
      );
    }
  } catch (err) {
    logger.error(
      { err, count: outcomes.length },
      "Failed to batch update suggestion outcomes",
    );
  }
}

// Time-stop conditions shared by the expiry sweep.
function expiryConditions() {
  return or(
    // New suggestions carry an explicit, strategy-aware time stop.
    lte(suggestionsTable.expiresAt, new Date()),
    // Legacy rows without expiresAt: expire intraday from previous days.
    // Rows WITH expiresAt are governed by it alone — off-hours scans
    // generate intraday setups the evening before their session.
    and(
      isNull(suggestionsTable.expiresAt),
      eq(suggestionsTable.tradeType, "INTRADAY"),
      lt(suggestionsTable.generatedAt, todayStartUTC())
    ),
    // Expire swing trades older than 14 days (backtest: edge needs ~10 trading days)
    and(
      eq(suggestionsTable.tradeType, "SWING"),
      lt(suggestionsTable.generatedAt, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000))
    )
  );
}

export async function expireOldSuggestions(): Promise<void> {
  try {
    // Honest fill model: a PENDING row's entry was never touched, so no trade
    // ever existed. Time it out as MISSED (excluded from win/loss calibration)
    // rather than EXPIRED, which calibration counts as a non-win.
    await db
      .update(suggestionsTable)
      .set({ status: "MISSED", closedAt: new Date() })
      .where(and(eq(suggestionsTable.status, "PENDING"), expiryConditions()));

    await db
      .update(suggestionsTable)
      .set({ status: "EXPIRED", closedAt: new Date() })
      .where(and(eq(suggestionsTable.status, "ACTIVE"), expiryConditions()));

    logger.info("Expired old intraday and swing suggestions");
  } catch (err) {
    logger.error({ err }, "Failed to expire old suggestions");
  }
}

export async function expireTodayIntraday(): Promise<void> {
  try {
    // Same MISSED/EXPIRED split as expireOldSuggestions: never-filled PENDING
    // rows must not enter win/loss stats at the end-of-day sweep.
    await db
      .update(suggestionsTable)
      .set({ status: "MISSED", closedAt: new Date() })
      .where(
        and(
          eq(suggestionsTable.status, "PENDING"),
          eq(suggestionsTable.tradeType, "INTRADAY"),
        ),
      );

    await db
      .update(suggestionsTable)
      .set({ status: "EXPIRED", closedAt: new Date() })
      .where(
        and(
          eq(suggestionsTable.status, "ACTIVE"),
          eq(suggestionsTable.tradeType, "INTRADAY"),
        ),
      );

    logger.info("Expired today's intraday suggestions at market close");
  } catch (err) {
    logger.error({ err }, "Failed to expire today's intraday suggestions");
  }
}
