import { db, suggestionsTable, liveOrdersTable } from "../../db/src";
import { eq, sql, gte, and, inArray } from "drizzle-orm";
import { intelligenceBus } from "../intelligence/event_bus";
import { getConfig } from "../config";
import { logger } from "../lib/logger";
import { 
  paperAccountsTable, 
  paperOrdersTable, 
  paperPositionsTable 
} from "../../db/src/schema/paper_trading";
import type { SuggestionTriggeredEvent, MarketTickEvent } from "../intelligence/types";
import { todayStartUTC } from "../lib/ist-time";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { isLiveModeActive, placeLiveOrder } from "./broker_orders";
import { stateStore } from "../lib/redis_state";
import { cashDeliveryCosts, cashIntradayCosts, isDeliveryTrade } from "../analysis/transaction_costs";
import Decimal from "decimal.js";
import { computeAdx14, ADX_TREND_THRESHOLD } from "./adx_gate";

/**
 * Session-cached ADX per symbol.
 *
 * Reads daily candles once per symbol per process. The trailing-stop gate runs
 * on every tick for every open position, so recomputing ADX from raw candles
 * each time would be pure waste; ADX(14) on daily bars barely moves intraday.
 *
 * TTL keeps it from going stale across sessions. A miss returns null, which the
 * caller treats as "trend unmeasured" and leaves the stop untouched - the safe
 * direction, since inventing a value could tighten a stop on no evidence.
 */
const adxCache = new Map<string, { adx: number | null; at: number }>();
const ADX_CACHE_TTL_MS = 15 * 60 * 1000;

async function getCachedAdx(symbol: string): Promise<number | null> {
  const hit = adxCache.get(symbol);
  if (hit && Date.now() - hit.at < ADX_CACHE_TTL_MS) return hit.adx;

  let adx: number | null = null;
  try {
    const rows = await db
      .select({ high: sql<number>`high`, low: sql<number>`low`, close: sql<number>`close` })
      .from(sql`candles`)
      .where(
        and(
          sql`instrument_key = ${symbol}`,
          sql`interval = 'day'`,
        ),
      )
      .orderBy(sql`timestamp desc`)
      .limit(60);
    if (rows.length >= 29) {
      // Query is newest-first; ADX needs oldest-first.
      adx = computeAdx14([...rows].reverse() as { high: number; low: number; close: number }[]);
    }
  } catch (err) {
    logger.debug({ err, symbol }, "PaperEngine: ADX unavailable; trailing ratchet stays capped at breakeven");
  }

  adxCache.set(symbol, { adx, at: Date.now() });
  return adx;
}

/**
 * Resolve the final order quantity, honouring the upstream risk decision.
 *
 * Kept as a pure, exported function so the sizing contract is directly testable
 * rather than buried inside the suggestionTriggered handler.
 *
 * `upstreamMaxRiskInr` is risk_engine.assessRisk's `maxRiskInr` — a HARD cap
 * that already accounts for portfolio state this engine cannot observe (open
 * positions, sector exposure, deployed capital, macro halving). `upstreamQuantity`
 * is the share count it approved. Both are optional so the realtime and intraday
 * paths, which do not call assessRisk, keep working.
 *
 * Returns quantity 0 when the risk budget cannot cover a single share. The
 * previous code used `Decimal.max(1, ...)`, which forced a 1-share trade in
 * exactly that case and so over-risked the very setups the risk engine had
 * deliberately sized down.
 */
export function resolveOrderQuantity(params: {
  balance: Decimal;
  riskPct: number;
  stopDistance: Decimal;
  upstreamMaxRiskInr?: Decimal | null;
  upstreamQuantity?: number | null;
}): { quantity: number; riskAmount: Decimal; cappedByUpstream: boolean } {
  const { balance, riskPct, stopDistance, upstreamMaxRiskInr, upstreamQuantity } = params;

  let riskAmount = balance.mul(riskPct).div(100);
  let cappedByUpstream = false;
  if (upstreamMaxRiskInr && upstreamMaxRiskInr.gt(0) && upstreamMaxRiskInr.lt(riskAmount)) {
    riskAmount = upstreamMaxRiskInr;
    cappedByUpstream = true;
  }

  if (stopDistance.lte(0) || stopDistance.isNaN()) {
    return { quantity: 0, riskAmount, cappedByUpstream };
  }

  const sharesAffordable = riskAmount.div(stopDistance).floor();
  if (sharesAffordable.lte(0)) {
    return { quantity: 0, riskAmount, cappedByUpstream };
  }

  let quantity = sharesAffordable.toNumber();
  if (upstreamQuantity != null && upstreamQuantity > 0 && quantity > upstreamQuantity) {
    quantity = upstreamQuantity;
  }

  return { quantity, riskAmount, cappedByUpstream };
}

export function calculateRequiredMargin(entryPrice: Decimal, quantity: Decimal | number, isSwingTrade: boolean): Decimal {
  return entryPrice.mul(quantity).div(isSwingTrade ? 1 : 5);
}

let engineActive = false;

// Track symbols with active OPEN paper positions to eliminate DB query thrashing on ticks
const activeOpenSymbols = new Set<string>();

async function syncActiveOpenSymbols() {
  try {
    const openPositions = await db.select({ symbol: paperPositionsTable.symbol })
      .from(paperPositionsTable)
      .where(eq(paperPositionsTable.status, "OPEN"));
    activeOpenSymbols.clear();
    for (const p of openPositions) {
      if (p.symbol) activeOpenSymbols.add(p.symbol);
    }
  } catch (err) {
    logger.warn({ err }, "PaperEngine: Failed to sync active open symbols");
  }
}

// MEDIUM FIX (Issue #22): Track circuit limit detection per symbol
const circuitLimitTracker = new Map<string, {
  consecutiveZeroVolumeTicks: number;
  firstDetectedAt: number;
  alerted: boolean;
}>();

// HIGH FIX: Prevent race conditions when multiple ticks for the same symbol arrive concurrently
const processingLocks = new Map<string, Promise<void>>();

function getStartingBalance(): string {
  return getConfig().tradingCapital.toFixed(2);
}

async function getAccount() {
  let [account] = await db.select().from(paperAccountsTable).limit(1);
  if (!account) {
    [account] = await db.insert(paperAccountsTable).values({
      userId: "system",
      balance: getStartingBalance(),
      startingBalance: getStartingBalance(),
      allocatedMargin: "0.00"
    }).returning();
  }
  return account;
}

export async function initPaperEngine() {
  if (engineActive) return;
  engineActive = true;

  await syncActiveOpenSymbols();

  const config = getConfig();
  // The engine runs in BOTH modes. PAPER: simulated fills only. LIVE: the same
  // simulated book is kept (position tracking + PnL), and every fill is
  // mirrored to the broker as a real order via broker_orders.ts.
  // An inconsistent config must NOT abort init: the per-event guards below
  // re-read config dynamically, so subscribing anyway means a Settings toggle
  // takes effect immediately instead of requiring a backend restart.
  if (!config.paperTradingEnabled && config.tradingMode !== "LIVE") {
    logger.warn(
      'Inconsistent trading config: paperTradingEnabled=false while tradingMode!="LIVE". ' +
      'Engine subscribed but will not trade until paper trading is enabled or LIVE mode is armed from Settings.'
    );
  }
  
  await getAccount(); // Ensure account exists

  intelligenceBus.subscribe("suggestionTriggered", async (event: SuggestionTriggeredEvent) => {
    try {
      const config = getConfig();
      if (!config.paperTradingEnabled && config.tradingMode !== "LIVE") {
        logger.warn({ suggestionId: event.suggestionId }, "PaperEngine: suggestion triggered but engine is disabled — no trade taken");
        return;
      }

      const [sugRow] = await db.select().from(suggestionsTable).where(eq(suggestionsTable.id, event.suggestionId)).limit(1);
      if (!sugRow) {
         logger.error({ suggestionId: event.suggestionId }, "PaperEngine: Triggered suggestion not found in DB");
         return;
      }
      
      // Upstream risk decision from risk_engine.assessRisk, already persisted on
      // the row by suggestions/generator.ts. This engine previously read NEITHER
      // and re-derived the position from a 0-100 `confidence` score that had
      // already been rewritten twice, so every control computed upstream — the
      // macro-risk halving, the 20%-of-capital cap, the 90% deployed-capital
      // cap, quarter-Kelly sizing — was discarded at the final step before an
      // order was sized. The risk engine's decision must bind execution.
      const upstreamMaxRisk = (() => {
        const raw = sugRow.maxRiskInr == null ? null : parseFloat(String(sugRow.maxRiskInr));
        return raw != null && Number.isFinite(raw) && raw > 0 ? new Decimal(raw) : null;
      })();
      const upstreamQuantity =
        sugRow.quantity != null && Number.isFinite(Number(sugRow.quantity)) && Number(sugRow.quantity) > 0
          ? Math.floor(Number(sugRow.quantity))
          : null;

      const suggestion = {
        id: sugRow.id,
        symbol: sugRow.symbol,
        direction: sugRow.direction,
        setup: sugRow.setupType,
        confidence: sugRow.confidence ?? 50,
        tradeType: sugRow.tradeType,
        entry: parseFloat(sugRow.entryPrice),
        stopLoss: parseFloat(sugRow.stopLoss),
        target: parseFloat(sugRow.target1),
        riskReward: sugRow.riskReward ? parseFloat(sugRow.riskReward) : 0,
        reasoning: sugRow.reasoning || "",
        marketRegime: sugRow.marketRegime,
        signalFactors: sugRow.signalFactors,
        aiScore: sugRow.aiScore,
        patternScore: sugRow.patternScore,
        technicalScore: sugRow.technicalScore,
        upstreamMaxRiskInr: upstreamMaxRisk,
        upstreamQuantity,
      };

      logger.info({ symbol: suggestion.symbol, confidence: suggestion.confidence, fillPrice: event.fillPrice }, "PaperEngine: Processing suggestionTriggered event");

      const account = await getAccount();
      const balance = new Decimal(account.balance);
      const allocated = new Decimal(account.allocatedMargin);
      const availableMargin = balance.minus(allocated);

      if (availableMargin.lte(0)) {
        logger.warn("PaperEngine: Insufficient margin for new trades");
        return;
      }

      // ---------------------------------------------------------
      // CIRCUIT BREAKER: Daily Drawdown Limit
      // ---------------------------------------------------------
      const maxDailyLossPct = new Decimal(config.maxDailyLossPct || 3.0);
      const maxDailyLossAmount = new Decimal(account.startingBalance).mul(maxDailyLossPct.div(100)).negated();

      const todaysClosedPositions = await db.select().from(paperPositionsTable).where(
        and(
          eq(paperPositionsTable.status, 'CLOSED'),
          gte(paperPositionsTable.closedAt, todayStartUTC())
        )
      );
      // Only OPEN positions created today count toward TODAY's drawdown. For
      // pure intraday MIS this is almost always same-day, but a position held
      // across a date boundary would otherwise leak its full running unrealized
      // PnL into the next day's circuit-breaker math and could trip (or mask)
      // the halt on PnL that wasn't incurred today.
      const openPositions = await db.select().from(paperPositionsTable).where(
        and(
          eq(paperPositionsTable.status, 'OPEN'),
          gte(paperPositionsTable.createdAt, todayStartUTC())
        )
      );
      const todaysPositions = [...todaysClosedPositions, ...openPositions];

      let totalDailyPnl = new Decimal(0);
      for (const pos of todaysPositions) {
        totalDailyPnl = totalDailyPnl.plus(pos.realizedPnl).plus(pos.unrealizedPnl);
      }

      if (totalDailyPnl.lte(maxDailyLossAmount)) {
        logger.error({ totalDailyPnl: totalDailyPnl.toNumber(), maxDailyLossAmount: maxDailyLossAmount.toNumber() }, "CIRCUIT BREAKER: Daily loss limit reached. Halting new trades.");
        // The operative halt is the `return` below — it stops this engine from
        // opening any new position for the rest of the session. The bus event is
        // fired for any diagnostic/telemetry listener; the user-facing loss-limit
        // alert is emitted independently by scheduler/jobs.ts over the WS, so the
        // absence of a subscriber here is intentional, not a missing wire.
        intelligenceBus.publish("dailyLossLimitReached", {
          lossAmount: totalDailyPnl.toNumber(),
          limitAmount: maxDailyLossAmount.toNumber()
        });
        return;
      }
      // ---------------------------------------------------------

      // ---------------------------------------------------------
      // Fixed-fractional risk. Suggestion hit rates and model conviction lack
      // verified net-return evidence and cannot justify increasing capital risk.
      // ---------------------------------------------------------
      const maxRiskCap = Math.max(0, Math.min(config.maxRiskPerTradePct ?? 1.0, 1.0));

      // Start with conservative base risk
      const riskPct = Math.min(0.25, maxRiskCap);

      // Confidence is retained for diagnostics only.
      const confidence = suggestion.confidence ?? 50;
      // Signal hit rates do not measure the distribution of broker net returns.
      // They cannot justify Kelly leverage or confidence-based risk increases.
      const isSwingTrade = isDeliveryTrade(suggestion.tradeType, suggestion.setup);

      // The risk engine's maxRiskInr is a HARD cap, not advice: it already
      // accounts for portfolio state (open positions, sector exposure, deployed
      // capital, macro halving) that this engine cannot see, so min() here is
      // what stops execution from re-expanding a position the portfolio
      // deliberately constrained.
      const locallyDerivedRisk = balance.mul(riskPct).div(100);
      const riskAmount = (
        suggestion.upstreamMaxRiskInr && suggestion.upstreamMaxRiskInr.lt(locallyDerivedRisk)
          ? suggestion.upstreamMaxRiskInr
          : locallyDerivedRisk
      );
      if (riskAmount !== locallyDerivedRisk) {
        logger.info(
          {
            symbol: suggestion.symbol,
            locallyDerivedRisk: locallyDerivedRisk.toNumber(),
            upstreamCap: suggestion.upstreamMaxRiskInr?.toNumber(),
          },
          "PaperEngine: clamped risk to the risk engine's maxRiskInr",
        );
      }

      logger.info({
        symbol: suggestion.symbol,
        confidence,
        riskPct,
        riskAmount: riskAmount.toNumber(),
      }, "PaperEngine: Position sized with risk-based approach");
      
      logger.info({ 
        symbol: suggestion.symbol, 
        confidence, 
        riskPct,
        riskAmount: riskAmount.toNumber() 
      }, "PaperEngine: Position sized with risk-based approach");
      // ---------------------------------------------------------
      
      // ---------------------------------------------------------
      // Bid-Ask Spread Blowout Guard + observed half-spread capture
      // ---------------------------------------------------------
      // Half-spread from the latest real quote doubles as the slippage model:
      // crossing the spread costs half of it relative to mid. A flat 0.05% is
      // brutal for liquid NIFTY-50 names and optimistic for small caps, so
      // paper P&L was systematically off per-symbol. Capped at 0.5% so one
      // junk quote can't model an absurd fill.
      let observedHalfSpreadFrac: number | null = null;
      let currentLtp: number | null = null;
      const ticks = await stateStore.getTicks(suggestion.symbol);
      if (ticks.length > 0) {
        const latestTick = ticks[ticks.length - 1];
        if (latestTick) {
          currentLtp = latestTick.price;
          if (latestTick.bid != null && latestTick.ask != null && latestTick.bid > 0 && latestTick.ask > 0 && latestTick.price > 0) {
            const spread = (latestTick.ask - latestTick.bid) / latestTick.price;
            if (spread > 0.02) { // Increased tolerance to 2%
               logger.warn({ symbol: suggestion.symbol, spread: (spread * 100).toFixed(2) }, "PaperEngine: Aborted entry due to bid-ask spread blowout > 2%");
               return;
            }
            if (spread >= 0) observedHalfSpreadFrac = Math.min(spread / 2, 0.005);
          }
        }
      }

      const isBuy = suggestion.direction === "BUY";
      // Entry slippage: observed half-spread when a real quote exists, else flat 0.05%
      const entrySlipFrac = observedHalfSpreadFrac ?? 0.0005;
      
      const originalEntryPrice = new Decimal(suggestion.entry);
      
      // Use the current LTP as the true execution price, falling back to theoretical entry if tick is missing
      const trueBasePrice = currentLtp !== null && currentLtp > 0 ? new Decimal(currentLtp) : originalEntryPrice;

      // Point-in-time missed fill guard: if trueBasePrice moved > 1.0% away from original theoretical entry in the wrong direction
      const priceSlipPct = isBuy 
          ? trueBasePrice.minus(originalEntryPrice).div(originalEntryPrice).mul(100) 
          : originalEntryPrice.minus(trueBasePrice).div(originalEntryPrice).mul(100);
          
      if (priceSlipPct.gt(1.0)) {
          logger.warn({ 
            symbol: suggestion.symbol, 
            priceSlipPct: priceSlipPct.toNumber(), 
            originalEntry: originalEntryPrice.toNumber(), 
            currentLtp: trueBasePrice.toNumber() 
          }, "PaperEngine: Aborted entry due to point-in-time missed fill guard (price moved > 1.0% away)");
          return;
      }

      const entry = isBuy ? trueBasePrice.mul(1 + entrySlipFrac) : trueBasePrice.mul(1 - entrySlipFrac);
      const stopLoss = new Decimal(suggestion.stopLoss);
      
      // CRITICAL FIX (Issue #1): Check for zero/invalid stop distance BEFORE using it
      // If entry equals stopLoss, this prevents division by zero
      const stopDistance = entry.minus(stopLoss).abs();
      if (stopDistance.isZero() || stopDistance.isNaN()) {
        logger.warn({ 
          symbol: suggestion.symbol, 
          entry: entry.toNumber(), 
          stopLoss: stopLoss.toNumber(),
          stopDistance: stopDistance.toNumber() 
        }, "PaperEngine: Aborted entry due to invalid stopDistance (entry equals stopLoss or NaN)");
        return;
      }

      // Resolve the share count through the single, testable implementation.
      // Never exceed the quantity the risk engine approved.
      const sizing = resolveOrderQuantity({
        balance,
        riskPct,
        stopDistance,
        upstreamMaxRiskInr: suggestion.upstreamMaxRiskInr,
        upstreamQuantity: suggestion.upstreamQuantity,
      });

      if (sizing.quantity <= 0) {
        logger.warn(
          {
            symbol: suggestion.symbol,
            riskAmount: riskAmount.toNumber(),
            stopDistance: stopDistance.toNumber(),
            upstreamMaxRiskInr: suggestion.upstreamMaxRiskInr?.toNumber() ?? null,
          },
          "PaperEngine: Aborted entry — risk budget cannot cover a single share",
        );
        return;
      }

      let quantity = sizing.quantity;
      const liveEntry = isLiveModeActive();

      // MIS intraday can use the configured 5x assumption; CNC delivery must
      // reserve the full notional or SWING orders can over-allocate cash.
      // Ensure we don't exceed available margin
      let requiredMargin = calculateRequiredMargin(entry, quantity, isSwingTrade);
      if (requiredMargin.gt(availableMargin)) {
        const marginPerShare = entry.div(isSwingTrade ? 1 : 5);
        quantity = availableMargin.div(marginPerShare).floor().toNumber();
        requiredMargin = calculateRequiredMargin(entry, quantity, isSwingTrade);
        if (quantity <= 0) {
          logger.warn({ symbol: suggestion.symbol, availableMargin: availableMargin.toNumber(), entry: entry.toNumber() }, "PaperEngine: Aborted entry because quantity is 0 after margin adjustment");
          return;
        }
      }

      // CRITICAL FIX (Issue #3): Use serializable isolation and row locking to prevent margin race condition
      // Two simultaneous suggestions could both see available margin and over-allocate
      const positionCreated = await db.transaction(async (tx) => {
        // 1. Lock the account row with FOR UPDATE to prevent concurrent modifications
        const lockRes = await tx.execute(sql`
          SELECT id, balance, allocated_margin
          FROM ${paperAccountsTable}
          WHERE id = ${account.id}
          FOR UPDATE
        `);
        const lockedAccount = lockRes.rows[0];

        if (!lockedAccount) {
          throw new Error("PaperEngine: Failed to lock account for update");
        }

        // Duplicate guard must live inside the lock: two suggestions for the
        // same symbol arriving together both pass a pre-transaction check.
        const dup = await tx.select({ id: paperPositionsTable.id })
          .from(paperPositionsTable)
          .where(and(
            eq(paperPositionsTable.symbol, suggestion.symbol),
            eq(paperPositionsTable.status, 'OPEN')
          ))
          .limit(1);
        if (dup.length > 0) {
          logger.info({ symbol: suggestion.symbol }, "PaperEngine: Skipping — already have an OPEN position on this symbol");
          return false;
        }

        // 2. Re-check available margin with locked values
        const currentBalance = new Decimal(lockedAccount.balance as string);
        const currentAllocated = new Decimal(lockedAccount.allocated_margin as string);
        const currentAvailable = currentBalance.minus(currentAllocated);
        
        if (requiredMargin.gt(currentAvailable)) {
          throw new Error("PaperEngine: Insufficient margin after lock (race condition detected)");
        }

        // 3. Create Position
        await tx.insert(paperPositionsTable).values({
          suggestionId: suggestion.id,
          symbol: suggestion.symbol,
          direction: suggestion.direction,
          quantity,
          avgEntryPrice: entry.toFixed(2),
          status: "OPEN",
          unrealizedPnl: "0.00",
          realizedPnl: "0.00",
          trailingStopLoss: stopLoss.toFixed(2),
        });

        // 4. Create Order
        await tx.insert(paperOrdersTable).values({
          suggestionId: suggestion.id,
          symbol: suggestion.symbol,
          direction: suggestion.direction,
          orderType: "ENTRY",
          quantity,
          price: entry.toFixed(2),
          contextData: {
            regime: suggestion.marketRegime,
            confidence: suggestion.confidence,
            factors: suggestion.signalFactors,
            scores: {
              ai: suggestion.aiScore,
              pattern: suggestion.patternScore,
              tech: suggestion.technicalScore
            }
          },
          // LIVE entries remain provisional until the broker confirms a fill.
          status: liveEntry ? "PENDING" : "EXECUTED"
        });

        // 5. Update Account with locked values
        await tx.update(paperAccountsTable)
          .set({ allocatedMargin: sql`allocated_margin + ${requiredMargin.toFixed(2)}` })
          .where(eq(paperAccountsTable.id, account.id));

        return true;
      });

      // Returning from the transaction callback only exits that callback. Do
      // not publish or mirror an entry when the duplicate guard skipped the
      // position insert.
      if (!positionCreated) return;

      activeOpenSymbols.add(suggestion.symbol);
      logger.info({ symbol: suggestion.symbol, quantity, requiredMargin }, "PaperEngine: Entered Position");

      broadcast(createServerEvent.positionUpdate({
        id: suggestion.id,
        symbol: suggestion.symbol,
        entryPrice: entry.toNumber(),
        stopLoss: stopLoss.toNumber(),
        target1: suggestion.target,
        direction: suggestion.direction as "BUY" | "SELL",
        mode: "OPEN",
      }));

      // LIVE mode submits the real order, but broker acceptance is not a fill.
      if (liveEntry) {
        const orderResult = await placeLiveOrder({
          suggestionId: suggestion.id,
          symbol: suggestion.symbol,
          direction: suggestion.direction as "BUY" | "SELL",
          quantity,
          orderType: "ENTRY",
          tradeType: isSwingTrade ? "SWING" : "INTRADAY",
          referencePrice: entry.toNumber(),
          stopLossPrice: stopLoss.toNumber(),
        });

        if (orderResult.ok) {
          await db.update(paperOrdersTable)
            .set({ status: "SUBMITTED" })
            .where(and(
              eq(paperOrdersTable.suggestionId, suggestion.id),
              eq(paperOrdersTable.orderType, "ENTRY"),
              eq(paperOrdersTable.status, "PENDING"),
            ));
        }

        if (!orderResult.ok) {
          if (orderResult.uncertain) {
            // The broker may have accepted an order whose acknowledgement was
            // lost. Keep the internal position and margin reserved so a retry
            // cannot create an untracked second exposure; reconciliation is
            // required before this order can be retried or cleared.
            logger.error(
              { symbol: suggestion.symbol, suggestionId: suggestion.id, liveOrderId: orderResult.liveOrderId, error: orderResult.error },
              "PaperEngine: LIVE order outcome is unknown; retaining reserved position pending broker reconciliation",
            );
          } else {
            logger.error({ symbol: suggestion.symbol, error: orderResult.error }, "PaperEngine: Live broker order was rejected — reverting internal DB position");
            await db.transaction(async (tx) => {
              await tx.update(paperOrdersTable)
                .set({ status: "FAILED" })
                .where(and(
                  eq(paperOrdersTable.suggestionId, suggestion.id),
                  eq(paperOrdersTable.orderType, "ENTRY"),
                  eq(paperOrdersTable.status, "PENDING"),
                ));

              await tx.update(paperPositionsTable)
                .set({ status: "REJECTED" })
                .where(sql`${paperPositionsTable.suggestionId} = ${suggestion.id} AND ${paperPositionsTable.status} = 'OPEN'`);

              await tx.update(paperAccountsTable)
                .set({ allocatedMargin: sql`GREATEST(0, allocated_margin - ${requiredMargin.toFixed(2)})` })
                .where(eq(paperAccountsTable.id, account.id));
            });
          }
        }

        broadcast(createServerEvent.systemAlert({
          message: orderResult.uncertain
            ? `LIVE order outcome unknown for ${suggestion.symbol}. Position and margin remain reserved. Reconcile with the broker before retrying.`
            : orderResult.ok
            ? `LIVE entry accepted for ${suggestion.symbol}; fill is unconfirmed. Position and margin remain reserved pending broker reconciliation.`
            : `LIVE order FAILED: ${suggestion.symbol} — ${orderResult.error} (Position reverted)`,
          severity: orderResult.ok && orderResult.protectiveStopPlaced !== false ? "info" : "error",
        }), "system");

        if (orderResult.ok && orderResult.protectiveStopPlaced === false) {
          broadcast(createServerEvent.systemAlert({
            message: `LIVE entry accepted for ${suggestion.symbol}, but the broker-side protective stop failed. Fill is unconfirmed; review the broker order immediately.`,
            severity: "error",
          }), "system");
        }
      }

    } catch (err) {
      logger.error({ err }, "PaperEngine: Failed to process suggestion");
    }
  });

  intelligenceBus.subscribe("marketTick", async (tick: MarketTickEvent) => {
    const symbol = tick.symbol;
    if (!activeOpenSymbols.has(symbol)) return;
    const lock = processingLocks.get(symbol) || Promise.resolve();
    
    const nextLock = lock.then(async () => {
      try {
        const config = getConfig();
        if (!config.paperTradingEnabled && config.tradingMode !== "LIVE") return;

        const positionsForSymbol = await db.select().from(paperPositionsTable)
          .where(and(
            eq(paperPositionsTable.status, 'OPEN'),
            eq(paperPositionsTable.symbol, symbol)
          ));

        if (positionsForSymbol.length === 0) {
          activeOpenSymbols.delete(symbol);
          return;
        }

      // We need the suggestion details to know the target and stopLoss
      // For simplicity, we can fetch them or assume position_tracker updates them
      // Let's fetch the suggestions
      const { suggestionsTable } = await import("../../db/src/schema/suggestions");
      const suggestions = await db.select().from(suggestionsTable)
        .where(inArray(suggestionsTable.id, positionsForSymbol.map(p => p.suggestionId!)));

      const sugMap = new Map(suggestions.map(s => [s.id, s]));

      for (const pos of positionsForSymbol) {
        const suggestion = sugMap.get(pos.suggestionId!);
        if (!suggestion) continue;

        if (isLiveModeActive()) {
          const unresolvedOrders = await db.select({ id: liveOrdersTable.id, status: liveOrdersTable.status, orderType: liveOrdersTable.orderType, statusMessage: liveOrdersTable.statusMessage })
            .from(liveOrdersTable)
            .where(and(
              eq(liveOrdersTable.suggestionId, pos.suggestionId!),
              inArray(liveOrdersTable.status, ["PENDING", "UNKNOWN", "PLACED"]),
            ))
            .limit(100);
          const unresolvedOrder = unresolvedOrders.find((order) =>
            order.orderType === "ENTRY" ||
            (order.orderType !== "GTT_STOP" && !order.statusMessage?.includes("GTT Stop-Loss Order Placed")),
          );
          if (unresolvedOrder) {
            logger.error(
              { symbol: pos.symbol, suggestionId: pos.suggestionId, liveOrderStatus: unresolvedOrder.status, liveOrderType: unresolvedOrder.orderType },
              "PaperEngine: Skipping automatic management until LIVE broker order fill is reconciled",
            );
            continue;
          }
        }

        const ltp = new Decimal(tick.ltp);
        const entryPrice = new Decimal(pos.avgEntryPrice);
        const qty = new Decimal(pos.quantity);
        const isBuy = pos.direction === "BUY";
        
        const currentStop = new Decimal(pos.trailingStopLoss || suggestion.stopLoss);
        const originalStop = new Decimal(suggestion.stopLoss);
        if (!suggestion.target1) {
          logger.error({ symbol: pos.symbol, suggestionId: suggestion.id }, "PaperEngine: target1 is missing — skipping tick processing for this position (schema violation)");
          continue;
        }
        const target = new Decimal(suggestion.target1);

        const unrealized = isBuy ? ltp.minus(entryPrice).mul(qty) : entryPrice.minus(ltp).mul(qty);
        
        let exitReason: "TARGET_EXIT" | "STOP_EXIT" | null = null;
        let newTrailingStop = currentStop;
        
        const risk = entryPrice.minus(originalStop).abs();
        
if (isBuy) {
            if (ltp.gte(target)) exitReason = "TARGET_EXIT";
            if (ltp.lte(currentStop)) exitReason = "STOP_EXIT";
            
            if (!exitReason && risk.gt(0)) {
              // The breakeven step itself is EV-safe and always allowed: for a
              // 2R target the EV-neutral threshold is 1/(1+2) = 33% of the path,
              // and breakeven at +1R is 50%, i.e. later than required.
              //
              // Everything PAST breakeven is ratcheting the stop up the ladder,
              // and that only has positive expectancy in a trend. In chop it
              // converts recoverable trades into locked-in breakeven, which is
              // where the round-trip loss came from. So the ratchet is gated on
              // measured trend strength, and unknown ADX leaves the stop alone.
              const trendAdx = await getCachedAdx(pos.symbol);
              const trending = trendAdx !== null && trendAdx >= ADX_TREND_THRESHOLD;
              const steps = ltp.minus(entryPrice).div(risk).floor();
              if (steps.gt(0)) {
                // steps >= 1 is the breakeven move: always allowed. Any step
                // beyond 1R is ratcheting the stop up the ladder, which only
                // has positive expectancy in a trend - so without a trend the
                // ratchet is capped at breakeven instead of disabled.
                const applied = trending ? steps : Decimal.min(steps, 1);
                const trailed = originalStop.plus(applied.mul(risk));
                if (trailed.gt(currentStop)) {
                  newTrailingStop = trailed;
                }
              }
            }
          } else {
if (ltp.lte(target)) exitReason = "TARGET_EXIT";
            if (ltp.gte(currentStop)) exitReason = "STOP_EXIT";
  
            if (!exitReason && risk.gt(0)) {
              // Same ADX gate as the long side: breakeven always, ratchet past
              // breakeven only when the regime is trending.
              const trendAdx = await getCachedAdx(pos.symbol);
              const trending = trendAdx !== null && trendAdx >= ADX_TREND_THRESHOLD;
              const steps = entryPrice.minus(ltp).div(risk).floor();
              if (steps.gt(0)) {
                const applied = trending ? steps : Decimal.min(steps, 1);
                const trailed = originalStop.minus(applied.mul(risk));
                if (trailed.lt(currentStop)) {
                  newTrailingStop = trailed;
                }
              }
            }
          }

        if (exitReason) {
          // MEDIUM FIX (Issue #22): Enhanced circuit limit detection with tracking
          // Check for consecutive zero-volume ticks to confirm circuit hit (not just one tick)
          //
          // An exit needs a counterparty quote: a sell requires a bid and a buy
          // requires an ask. LTP-only fallback ticks cannot establish a fill.
          // NOTE (Issue #M6): tick.volume is the running DAY-cumulative volume from
          // the 1d OHLC candle, not per-tick traded quantity. It is 0 only pre-open
          // and null whenever a WS packet carries LTP/depth without the 1d candle, so
          // it is not a circuit-halt signal — using it here produced false positives
          // even on real WS ticks. The genuine zero-counterparty signal is an absent
          // bid (for a sell-side exit) or ask (for a buy-side exit) on a live book.
          const isLiquidityZero =
            (isBuy && (tick.bid == null || tick.bid <= 0)) ||
            (!isBuy && (tick.ask == null || tick.ask <= 0));

          if (isLiquidityZero) {
            const tracker = circuitLimitTracker.get(pos.symbol) || {
              consecutiveZeroVolumeTicks: 0,
              firstDetectedAt: Date.now(),
              alerted: false,
            };
            
            tracker.consecutiveZeroVolumeTicks++;
            const elapsedSeconds = (Date.now() - tracker.firstDetectedAt) / 1000;
            
            // Defer exit if we haven't confirmed circuit limit yet (need 3+ consecutive ticks)
            if (tracker.consecutiveZeroVolumeTicks < 3) {
              circuitLimitTracker.set(pos.symbol, tracker);
              logger.warn({ 
                symbol: pos.symbol, 
                exitReason, 
                consecutiveTicks: tracker.consecutiveZeroVolumeTicks,
                bid: tick.bid, 
                ask: tick.ask 
              }, "PaperEngine: Potential circuit limit detected, monitoring...");
              continue;
            }
            
            // Never invent a fill from LTP when the required side of the book
            // is absent. Keep the position and margin reserved until liquidity
            // returns, then let the normal exit path verify the broker quantity.
            if ((tracker.consecutiveZeroVolumeTicks >= 5 || elapsedSeconds > 30) && !tracker.alerted) {
              tracker.alerted = true;
              logger.error(
                { symbol: pos.symbol, exitReason, consecutiveTicks: tracker.consecutiveZeroVolumeTicks, durationSeconds: elapsedSeconds },
                "PaperEngine: Exit is blocked because no counterparty quote is available; position remains open",
              );
              broadcast(createServerEvent.systemAlert({
                message: `Exit for ${pos.symbol} is blocked because no counterparty quote is available. Position and margin remain reserved.`,
                severity: "error",
              }), "system");
            }
            
            // Still waiting for circuit to clear
            circuitLimitTracker.set(pos.symbol, tracker);
            logger.warn({ 
              symbol: pos.symbol, 
              exitReason, 
              consecutiveTicks: tracker.consecutiveZeroVolumeTicks,
              bid: tick.bid, 
              ask: tick.ask 
            }, "PaperEngine: Circuit limit confirmed, waiting for liquidity to return");
            continue;
          } else {
            // Liquidity returned - clear tracker
            circuitLimitTracker.delete(pos.symbol);
          }

          // HIGH FIX (Issue #11): Apply slippage to LTP at trigger time, not to target/stop prices
          // Previous code applied slippage to target/stop, which artificially reduced profits
          // Now we use actual LTP when condition triggers and apply realistic slippage
          const ltpAtTrigger = new Decimal(tick.ltp);
          // Exit slippage from the triggering tick's own quote when present
          // (half-spread vs mid, capped 0.5%); flat 0.05% only as fallback.
          let exitSlipFrac = 0.0005;
          if (tick.bid != null && tick.ask != null && tick.bid > 0 && tick.ask > 0 && tick.ltp > 0) {
            const spreadFrac = (tick.ask - tick.bid) / tick.ltp;
            if (spreadFrac >= 0) exitSlipFrac = Math.min(spreadFrac / 2, 0.005);
          }
          let slippedLtp: Decimal;

          if (isBuy) {
            // For BUY positions, we SELL on exit - slippage works against us
            slippedLtp = ltpAtTrigger.mul(1 - exitSlipFrac);
          } else {
            // For SELL positions, we BUY on exit - slippage works against us
            slippedLtp = ltpAtTrigger.mul(1 + exitSlipFrac);
          }
          const isSwingExit = isDeliveryTrade(suggestion.tradeType, suggestion.setupType);

          if (isLiveModeActive()) {
            const exitOrder = await placeLiveOrder({
              suggestionId: pos.suggestionId,
              symbol: pos.symbol,
              direction: isBuy ? "SELL" : "BUY",
              quantity: qty.toNumber(),
              orderType: exitReason,
              tradeType: isSwingExit ? "SWING" : "INTRADAY",
              referencePrice: slippedLtp.toNumber(),
            });

            await db.insert(paperOrdersTable).values({
              suggestionId: pos.suggestionId,
              symbol: pos.symbol,
              direction: isBuy ? "SELL" : "BUY",
              orderType: exitReason as string,
              quantity: qty.toNumber(),
              price: slippedLtp.toFixed(2),
              status: exitOrder.ok ? "SUBMITTED" : exitOrder.uncertain ? "PENDING" : "FAILED",
            });

            if (exitOrder.ok) {
              logger.warn(
                { symbol: pos.symbol, suggestionId: pos.suggestionId, liveOrderId: exitOrder.liveOrderId, brokerOrderId: exitOrder.brokerOrderId },
                "PaperEngine: LIVE exit accepted; retaining position and margin until broker fill is reconciled",
              );
              broadcast(createServerEvent.systemAlert({
                message: `LIVE exit accepted for ${pos.symbol}; fill is unconfirmed. Position and margin remain reserved pending broker reconciliation.`,
                severity: "error",
              }), "system");
            } else {
              logger.error(
                { symbol: pos.symbol, suggestionId: pos.suggestionId, liveOrderId: exitOrder.liveOrderId, error: exitOrder.error, uncertain: exitOrder.uncertain },
                "PaperEngine: LIVE exit not confirmed; retaining position and margin",
              );
              broadcast(createServerEvent.systemAlert({
                message: exitOrder.uncertain
                  ? `LIVE exit outcome for ${pos.symbol} is unknown. Position and margin remain reserved; reconcile with the broker.`
                  : `LIVE exit failed for ${pos.symbol}. Position and margin remain reserved.`,
                severity: "error",
              }), "system");
            }
            continue;
          }
          
          const grossPnl = isBuy ? slippedLtp.minus(entryPrice).mul(qty) : entryPrice.minus(slippedLtp).mul(qty);
          const totalCharges = new Decimal(isSwingExit
            ? cashDeliveryCosts(entryPrice.toNumber(), slippedLtp.toNumber(), qty.toNumber())
            : cashIntradayCosts(isBuy ? entryPrice.toNumber() : slippedLtp.toNumber(),
              isBuy ? slippedLtp.toNumber() : entryPrice.toNumber(), qty.toNumber()));
          const realizedPnl = grossPnl.minus(totalCharges);

          const releasedMargin = calculateRequiredMargin(entryPrice, qty, isSwingExit);

          const account = await getAccount();
          await db.transaction(async (tx) => {
            // 1. Close Position
            const updateRes = await tx.update(paperPositionsTable)
              .set({
                status: "CLOSED",
                realizedPnl: realizedPnl.toFixed(2),
                unrealizedPnl: "0.00",
                closedAt: sql`now()`
              })
              .where(sql`${paperPositionsTable.id} = ${pos.id} AND ${paperPositionsTable.status} = 'OPEN'`)
              .returning();

            if (updateRes.length === 0) {
              throw new Error("PaperEngine: Race condition - position already closed");
            }

            // 2. Create Exit Order
            await tx.insert(paperOrdersTable).values({
              suggestionId: pos.suggestionId,
              symbol: pos.symbol,
              direction: isBuy ? "SELL" : "BUY",
              orderType: exitReason as string,
              quantity: qty.toNumber(),
              price: slippedLtp.toFixed(2),
              status: "EXECUTED"
            });

            // 3. Update Account (release margin cleanly without going below zero)
            await tx.update(paperAccountsTable)
              .set({ 
                allocatedMargin: sql`GREATEST(0, allocated_margin - ${releasedMargin.toFixed(2)})`,
                balance: sql`balance + ${realizedPnl.toFixed(2)}`
              })
              .where(eq(paperAccountsTable.id, account.id));
          });

          logger.info({ symbol: pos.symbol, exitReason, realizedPnl: realizedPnl.toNumber() }, "PaperEngine: Exited Position");

          broadcast(createServerEvent.positionUpdate({
            id: pos.id,
            symbol: pos.symbol,
            entryPrice: parseFloat(pos.avgEntryPrice),
            stopLoss: parseFloat(pos.trailingStopLoss ?? "0"),
            target1: 0,
            direction: pos.direction as "BUY" | "SELL",
            mode: "CLOSED",
          }));

        } else {
          if (!newTrailingStop.equals(currentStop) || unrealized.toFixed(2) !== pos.unrealizedPnl) {
            await db.update(paperPositionsTable)
              .set({
                unrealizedPnl: unrealized.toFixed(2),
                trailingStopLoss: newTrailingStop.toFixed(2)
              })
              .where(eq(paperPositionsTable.id, pos.id));
          }
        }
        }
      } catch (err) {
        logger.error({ err }, "PaperEngine: Failed to process tick");
      }
    }).catch(err => {
      logger.error({ err }, "PaperEngine: Unhandled error in processing lock chain");
    }).finally(() => {
      if (processingLocks.get(symbol) === nextLock) {
        processingLocks.delete(symbol);
      }
    });
    
    processingLocks.set(symbol, nextLock);
  });

  logger.info("PaperTrading Engine Initialized");
}
