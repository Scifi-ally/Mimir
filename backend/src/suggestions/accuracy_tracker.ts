import { db } from "../../db/src";
import { suggestionsTable, rejectedCandidatesTable } from "../../db/src";
import { eq, and, lt, lte, or, inArray, isNull, sql } from "drizzle-orm";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { logger } from "../lib/logger";
import { todayStartUTC } from "../lib/ist-time";
import { tickDistribution } from "../market_data/tick_distribution";

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

// Outcome polling runs every 60s; look slightly further back so a tick landing
// just before the previous sweep isn't missed, without reaching into ticks
// that predate this suggestion's activation window.
const TICK_LOOKBACK_MS = 75_000;

// Fill moment of suggestions promoted PENDING→ACTIVE by this process. The DB
// has no activatedAt column, and without this floor the tick scan on the very
// next sweep can read PRE-FILL ticks — a print that touched the stop before
// the entry ever filled would mislabel the trade STOP_HIT.
const promotedAtMs = new Map<string, number>();

/**
 * Sequence which exit level was touched FIRST within the last poll gap using
 * the in-memory tick history. The current-price check alone mislabels two
 * cases: (a) price swept target then reversed through stop between polls —
 * labeled STOP_HIT though the target filled first; (b) price swept target and
 * came back to the middle — no outcome fires at all and the trade lingers.
 * Returns null when no tick in the window touched any level (or no WS history
 * exists for the symbol, e.g. REST-fallback polling), letting the caller fall
 * through to the current-price logic.
 */
function firstTouchFromTicks(
  direction: string,
  symbol: string,
  notBeforeMs: number,
  stop: number,
  t1: number,
  t2: number | null,
  // When set, the hypothetical position only exists once a tick touches this
  // entry level — level prints before the entry-trigger tick are ignored.
  // Used by counterfactual resolution; real ACTIVE rows pass undefined.
  entryTrigger?: { entry: number },
): { level: "STOP" | "T1" | "T2"; price: number } | null {
  const ticks = tickDistribution.getTickHistory(symbol);
  if (ticks.length === 0) return null;
  const windowStart = Math.max(Date.now() - TICK_LOOKBACK_MS, notBeforeMs);
  let entered = entryTrigger == null;
  for (const tk of ticks) {
    if (tk.timestamp < windowStart) continue;
    const p = tk.ltp;
    if (p <= 0) continue;
    if (!entered) {
      const touched = direction === "BUY" ? p >= entryTrigger!.entry : p <= entryTrigger!.entry;
      if (!touched) continue;
      entered = true;
      // The entry-touch tick itself can also touch a level — fall through.
    }
    // Within a single tick the stop is checked first — same pessimistic
    // convention as the price-based path when one print crosses both.
    if (direction === "BUY") {
      if (p <= stop) return { level: "STOP", price: p };
      if (t2 != null && p >= t2) return { level: "T2", price: t2 };
      if (p >= t1) return { level: "T1", price: t1 };
    } else {
      if (p >= stop) return { level: "STOP", price: p };
      if (t2 != null && p <= t2) return { level: "T2", price: t2 };
      if (p <= t1) return { level: "T1", price: t1 };
    }
  }
  return null;
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

  // Prune fill-moment entries for rows that left ACTIVE/PENDING by another
  // path (expiry sweep, manual close) so the map can't grow unbounded.
  const activeIds = new Set(active.map((s) => s.id));
  for (const id of promotedAtMs.keys()) {
    if (!activeIds.has(id)) promotedAtMs.delete(id);
  }

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
    let exitPrice = price;

    // Prefer tick-sequenced first-touch over the polled snapshot: a 60s poll
    // gap can sweep both stop and target, and labeling by current price alone
    // both mislabels those trades and biases win-rate stats (and everything
    // trained on them) pessimistically low in fast markets.
    // Floor the tick window at the fill moment when this process promoted the
    // row PENDING→ACTIVE, so pre-fill prints can't decide the outcome.
    const generatedAtMs = suggestion.generatedAt ? new Date(suggestion.generatedAt).getTime() : 0;
    const notBeforeMs = Math.max(generatedAtMs, promotedAtMs.get(suggestion.id) ?? 0);
    const firstTouch = firstTouchFromTicks(suggestion.direction, suggestion.symbol, notBeforeMs, stop, t1, t2);

    if (firstTouch) {
      exitPrice = firstTouch.price;
      if (firstTouch.level === "STOP") {
        outcome = "STOP_HIT";
        pnl = suggestion.direction === "BUY"
          ? netPnl(entry, exitPrice, qty, (exitPrice - entry) * qty)
          : netPnl(entry, exitPrice, qty, (entry - exitPrice) * qty);
      } else if (firstTouch.level === "T2") {
        outcome = "TARGET_2_HIT";
        exitPrice = t2!;
        pnl = suggestion.direction === "BUY"
          ? netPnl(entry, t2!, qty, (t2! - entry) * qty)
          : netPnl(entry, t2!, qty, (entry - t2!) * qty);
      } else {
        outcome = "TARGET_1_HIT";
        exitPrice = t1;
        pnl = suggestion.direction === "BUY"
          ? netPnl(entry, t1, qty, (t1 - entry) * qty)
          : netPnl(entry, t1, qty, (entry - t1) * qty);
      }
    } else if (suggestion.direction === "BUY") {
      // No usable tick history (e.g. REST-fallback polling) — fall back to the
      // polled price. Stop checked before targets: pessimistic label wins.
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
        outcomePrice: exitPrice,
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
        promotedAtMs.set(promo.id, Date.now());
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
      promotedAtMs.delete(outcome.id);

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

/**
 * Resolve counterfactual outcomes for rejected candidates: would the trade
 * have triggered, and if so, which level would it have hit first? Same
 * tick-sequenced first-touch logic as real suggestions; falls back to the
 * polled price. Candidates older than one session resolve NEVER_TRIGGERED.
 * This is what turns the rejected-candidate log into ranker training data.
 */
export async function resolveCounterfactuals(prices: PriceMap): Promise<void> {
  let pending: (typeof rejectedCandidatesTable.$inferSelect)[];
  try {
    pending = await db
      .select()
      .from(rejectedCandidatesTable)
      .where(eq(rejectedCandidatesTable.cfStatus, "PENDING"));
  } catch (err) {
    logger.error({ err }, "Failed to fetch pending rejected candidates");
    return;
  }
  if (pending.length === 0) return;

  const now = new Date();
  const resolved: Array<{ id: string; cfStatus: string }> = [];

  for (const cand of pending) {
    // Intraday counterfactual window: one session. Past it, the planned
    // entry was never touched in time — the trade never existed.
    const ageMs = now.getTime() - new Date(cand.createdAt).getTime();
    const expired = ageMs > 24 * 60 * 60 * 1000;

    const price = prices[cand.symbol];
    if (price == null) {
      if (expired) resolved.push({ id: cand.id, cfStatus: "NEVER_TRIGGERED" });
      continue;
    }

    const entry = parseFloat(cand.entryPrice);
    const stop = parseFloat(cand.stopLoss);
    const t1 = parseFloat(cand.target1);
    const isBuy = cand.direction === "BUY";

    const touched = isBuy ? price >= entry : price <= entry;
    if (!touched) {
      if (expired) resolved.push({ id: cand.id, cfStatus: "NEVER_TRIGGERED" });
      continue;
    }

    // Sequence within the tick window, but only count level touches AFTER a
    // tick actually crossed the planned entry — the polled `touched` above
    // could be a later snapshot, and pre-entry stop prints are not losses.
    const firstTouch = firstTouchFromTicks(
      cand.direction, cand.symbol, new Date(cand.createdAt).getTime(), stop, t1, null,
      { entry },
    );
    if (firstTouch) {
      resolved.push({ id: cand.id, cfStatus: firstTouch.level === "STOP" ? "WOULD_HAVE_LOST" : "WOULD_HAVE_WON" });
    } else if (isBuy ? price <= stop : price >= stop) {
      resolved.push({ id: cand.id, cfStatus: "WOULD_HAVE_LOST" });
    } else if (isBuy ? price >= t1 : price <= t1) {
      resolved.push({ id: cand.id, cfStatus: "WOULD_HAVE_WON" });
    } else if (expired) {
      // Triggered but neither level hit within the window: label by sign of
      // the open excursion so the row still carries signal.
      const favorable = isBuy ? price > entry : price < entry;
      resolved.push({ id: cand.id, cfStatus: favorable ? "WOULD_HAVE_WON" : "WOULD_HAVE_LOST" });
    }
  }

  for (const r of resolved) {
    try {
      await db
        .update(rejectedCandidatesTable)
        .set({ cfStatus: r.cfStatus, cfResolvedAt: now })
        .where(eq(rejectedCandidatesTable.id, r.id));
    } catch (err) {
      logger.warn({ err, id: r.id }, "Failed to resolve counterfactual");
    }
  }
  if (resolved.length > 0) {
    logger.info({ resolved: resolved.length, pending: pending.length }, "Counterfactual outcomes resolved");
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
