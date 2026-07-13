import { db } from "../../db/src";
import { suggestionsTable } from "../../db/src";
import { eq, and, lt, lte, or } from "drizzle-orm";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { logger } from "../lib/logger";
import { todayStartUTC } from "../lib/ist-time";

interface PriceMap {
  [symbol: string]: number;
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
      .where(eq(suggestionsTable.status, "ACTIVE"));
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

  for (const suggestion of active) {
    const price = prices[suggestion.symbol];
    if (price == null) continue;

    const entry = parseFloat(suggestion.entryPrice);
    const stop = parseFloat(suggestion.stopLoss);
    const t1 = parseFloat(suggestion.target1);
    const t2 = suggestion.target2 ? parseFloat(suggestion.target2) : null;

    let outcome: string | null = null;
    let pnl: number | null = null;

    if (suggestion.direction === "BUY") {
      if (t2 && price >= t2) {
        outcome = "TARGET_2_HIT";
        pnl = (t2 - entry) * (suggestion.quantity ?? 0);
      } else if (price >= t1) {
        outcome = "TARGET_1_HIT";
        pnl = (t1 - entry) * (suggestion.quantity ?? 0);
      } else if (price <= stop) {
        outcome = "STOP_HIT";
        pnl = (price - entry) * (suggestion.quantity ?? 0);
      }
    } else {
      if (t2 && price <= t2) {
        outcome = "TARGET_2_HIT";
        pnl = (entry - t2) * (suggestion.quantity ?? 0);
      } else if (price <= t1) {
        outcome = "TARGET_1_HIT";
        pnl = (entry - t1) * (suggestion.quantity ?? 0);
      } else if (price >= stop) {
        outcome = "STOP_HIT";
        pnl = (entry - price) * (suggestion.quantity ?? 0);
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
            | "EXPIRED",
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

export async function expireOldSuggestions(): Promise<void> {
  try {
    await db
      .update(suggestionsTable)
      .set({
        status: "EXPIRED",
        closedAt: new Date(),
      })
      .where(
        and(
          eq(suggestionsTable.status, "ACTIVE"),
          or(
            // New suggestions carry an explicit, strategy-aware time stop.
            lte(suggestionsTable.expiresAt, new Date()),
            // Expire intraday trades from previous days
            and(
              eq(suggestionsTable.tradeType, "INTRADAY"),
              lt(suggestionsTable.generatedAt, todayStartUTC())
            ),
            // Expire swing trades older than 3 days
            and(
              eq(suggestionsTable.tradeType, "SWING"),
              lt(suggestionsTable.generatedAt, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000))
            )
          )
        )
      );

    logger.info("Expired old intraday and swing suggestions");
  } catch (err) {
    logger.error({ err }, "Failed to expire old suggestions");
  }
}

export async function expireTodayIntraday(): Promise<void> {
  try {
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
