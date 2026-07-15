import { db } from "../../db/src";
import { eq, sql, gte, and } from "drizzle-orm";
import { intelligenceBus } from "../intelligence/event_bus";
import { getConfig } from "../config";
import { logger } from "../lib/logger";
import { 
  paperAccountsTable, 
  paperOrdersTable, 
  paperPositionsTable 
} from "../../db/src/schema/paper_trading";
import type { SuggestionGeneratedEvent, MarketTickEvent } from "../intelligence/types";
import { todayStartUTC } from "../lib/ist-time";
import { stateStore } from "../lib/redis_state";
import Decimal from "decimal.js";

let engineActive = false;

// MEDIUM FIX (Issue #22): Track circuit limit detection per symbol
const circuitLimitTracker = new Map<string, {
  consecutiveZeroVolumeTicks: number;
  firstDetectedAt: number;
}>();

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
  
  const config = getConfig();
  if (!config.paperTradingEnabled) {
    throw new Error(
      'Live trading is not implemented. Set paperTradingEnabled=true in config, ' +
      'or implement real order placement + broker reconciliation before disabling paper trading.'
    );
  }
  
  await getAccount(); // Ensure account exists

  intelligenceBus.subscribe("suggestionGenerated", async (event: SuggestionGeneratedEvent) => {
    try {
      const config = getConfig();
      if (!config.paperTradingEnabled) {
        logger.debug("PaperEngine: Received suggestion but paperTradingEnabled is false");
        return;
      }
      logger.info({ symbol: event.suggestion.symbol, confidence: event.suggestion.confidence }, "PaperEngine: Processing suggestionGenerated event");

      const { suggestion } = event;
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
      const openPositions = await db.select().from(paperPositionsTable).where(
        eq(paperPositionsTable.status, 'OPEN')
      );
      const todaysPositions = [...todaysClosedPositions, ...openPositions];

      let totalDailyPnl = new Decimal(0);
      for (const pos of todaysPositions) {
        totalDailyPnl = totalDailyPnl.plus(pos.realizedPnl).plus(pos.unrealizedPnl);
      }

      if (totalDailyPnl.lte(maxDailyLossAmount)) {
        logger.error({ totalDailyPnl: totalDailyPnl.toNumber(), maxDailyLossAmount: maxDailyLossAmount.toNumber() }, "CIRCUIT BREAKER: Daily loss limit reached. Halting new trades.");
        intelligenceBus.publish("dailyLossLimitReached", {
          lossAmount: totalDailyPnl.toNumber(),
          limitAmount: maxDailyLossAmount.toNumber()
        });
        return;
      }
      // ---------------------------------------------------------

      // ---------------------------------------------------------
      // Dynamic Position Sizing - Simplified Risk-Based Approach
      // HIGH FIX (Issue #17): Removed Kelly Criterion due to uncalibrated confidence
      // Kelly requires actual win probability, but we only have AI confidence scores
      // Using conservative fixed-percentage risk instead
      // ---------------------------------------------------------
      const maxRiskCap = config.maxRiskPerTradePct || 2.0; // Hard cap at 2% risk
      
      // Start with conservative base risk
      let riskPct = 1.0; // 1% base risk
      
      // Scale up slightly for high confidence (but conservatively)
      const confidence = suggestion.confidence || 50;
      if (confidence >= 80) {
        riskPct = 1.5; // High confidence: 1.5%
      } else if (confidence >= 70) {
        riskPct = 1.25; // Medium-high: 1.25%
      } else if (confidence < 60) {
        riskPct = 0.5; // Low confidence: reduce to 0.5%
      }
      
      // Ensure within bounds
      riskPct = Math.min(Math.max(riskPct, 0.5), maxRiskCap);
      const riskAmount = balance.mul(riskPct).div(100);
      
      logger.info({ 
        symbol: suggestion.symbol, 
        confidence, 
        riskPct,
        riskAmount: riskAmount.toNumber() 
      }, "PaperEngine: Position sized with risk-based approach");
      // ---------------------------------------------------------
      
      // ---------------------------------------------------------
      // Bid-Ask Spread Blowout Guard
      // ---------------------------------------------------------
      const ticks = await stateStore.getTicks(suggestion.symbol);
      if (ticks.length > 0) {
        const latestTick = ticks[ticks.length - 1];
        if (latestTick && latestTick.bid != null && latestTick.ask != null && latestTick.price > 0) {
          const spread = (latestTick.ask - latestTick.bid) / latestTick.price;
          if (spread > 0.02) { // Increased tolerance to 2%
             logger.warn({ symbol: suggestion.symbol, spread: (spread * 100).toFixed(2) }, "PaperEngine: Aborted entry due to bid-ask spread blowout > 2%");
             return;
          }
        }
      }

      const isBuy = suggestion.direction === "BUY";
      // 0.05% slippage on entry
      const rawEntry = new Decimal(suggestion.entry);
      const entry = isBuy ? rawEntry.mul(1.0005) : rawEntry.mul(0.9995);
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

      // Calculate quantity, but guarantee at least 1 share if margin allows it
      let quantity = Decimal.max(1, riskAmount.div(stopDistance).floor()).toNumber();

      // Proper trader intraday MIS leverage on NSE (5x leverage -> 20% margin required per share)
      const intradayLeverage = new Decimal(5);
      const marginPerShare = entry.div(intradayLeverage);

      // Ensure we don't exceed available margin
      let requiredMargin = marginPerShare.mul(quantity);
      if (requiredMargin.gt(availableMargin)) {
        quantity = availableMargin.div(marginPerShare).floor().toNumber();
        requiredMargin = marginPerShare.mul(quantity); // Recalculate with new quantity
        if (quantity <= 0) {
          logger.warn({ symbol: suggestion.symbol, availableMargin: availableMargin.toNumber(), entry: entry.toNumber() }, "PaperEngine: Aborted entry because quantity is 0 after margin adjustment");
          return;
        }
      }

      // Duplicate position guard: skip if already have an OPEN position on same symbol
      const existingPosition = await db.select({ id: paperPositionsTable.id })
        .from(paperPositionsTable)
        .where(and(
          eq(paperPositionsTable.symbol, suggestion.symbol),
          eq(paperPositionsTable.status, 'OPEN')
        ))
        .limit(1);

      if (existingPosition.length > 0) {
        logger.info({ symbol: suggestion.symbol }, "PaperEngine: Skipping — already have an OPEN position on this symbol");
        return;
      }

      // CRITICAL FIX (Issue #3): Use serializable isolation and row locking to prevent margin race condition
      // Two simultaneous suggestions could both see available margin and over-allocate
      await db.transaction(async (tx) => {
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
          status: "EXECUTED"
        });

        // 5. Update Account with locked values
        await tx.update(paperAccountsTable)
          .set({ allocatedMargin: sql`allocated_margin + ${requiredMargin.toFixed(2)}` })
          .where(eq(paperAccountsTable.id, account.id));
      });

      logger.info({ symbol: suggestion.symbol, quantity, requiredMargin }, "PaperEngine: Entered Position");

    } catch (err) {
      logger.error({ err }, "PaperEngine: Failed to process suggestion");
    }
  });

  intelligenceBus.subscribe("marketTick", async (tick: MarketTickEvent) => {
    try {
      const config = getConfig();
      if (!config.paperTradingEnabled) return;

      const positionsForSymbol = await db.select().from(paperPositionsTable)
        .where(and(
          eq(paperPositionsTable.status, 'OPEN'),
          eq(paperPositionsTable.symbol, tick.symbol)
        ));

      if (positionsForSymbol.length === 0) return;

      // We need the suggestion details to know the target and stopLoss
      // For simplicity, we can fetch them or assume position_tracker updates them
      // Let's fetch the suggestions
      const { suggestionsTable } = await import("../../db/src/schema/suggestions");
      const { inArray } = await import("drizzle-orm");
      const suggestions = await db.select().from(suggestionsTable)
        .where(inArray(suggestionsTable.id, positionsForSymbol.map(p => p.suggestionId!)));

      const sugMap = new Map(suggestions.map(s => [s.id, s]));

      for (const pos of positionsForSymbol) {
        const suggestion = sugMap.get(pos.suggestionId!);
        if (!suggestion) continue;

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
            const steps = ltp.minus(entryPrice).div(risk).floor();
            if (steps.gt(0)) {
              const trailed = originalStop.plus(steps.mul(risk));
              if (trailed.gt(currentStop)) {
                newTrailingStop = trailed;
              }
            }
          }
        } else {
          if (ltp.lte(target)) exitReason = "TARGET_EXIT";
          if (ltp.gte(currentStop)) exitReason = "STOP_EXIT";

          if (!exitReason && risk.gt(0)) {
            const steps = entryPrice.minus(ltp).div(risk).floor();
            if (steps.gt(0)) {
              const trailed = originalStop.minus(steps.mul(risk));
              if (trailed.lt(currentStop)) {
                newTrailingStop = trailed;
              }
            }
          }
        }

        if (exitReason) {
          // MEDIUM FIX (Issue #22): Enhanced circuit limit detection with tracking
          // Check for consecutive zero-volume ticks to confirm circuit hit (not just one tick)
          const isLiquidityZero = (tick.volume == null || tick.volume === 0) || 
                                  (isBuy && (tick.bid == null || tick.bid === 0)) || 
                                  (!isBuy && (tick.ask == null || tick.ask === 0));
          
          if (isLiquidityZero) {
            const tracker = circuitLimitTracker.get(pos.symbol) || {
              consecutiveZeroVolumeTicks: 0,
              firstDetectedAt: Date.now()
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
            
            // Force exit after 30 seconds of circuit limit (5+ ticks and 30+ seconds)
            if (tracker.consecutiveZeroVolumeTicks >= 5 || elapsedSeconds > 30) {
              logger.error({
                symbol: pos.symbol,
                exitReason,
                consecutiveTicks: tracker.consecutiveZeroVolumeTicks,
                durationSeconds: elapsedSeconds
              }, "PaperEngine: Forcing exit due to prolonged circuit limit - using wider slippage");
              
              // Force exit with wider slippage (0.5% instead of 0.05%)
              const ltpAtTrigger = new Decimal(tick.ltp || pos.avgEntryPrice); // Fallback to entry if no LTP
              const slippedLtp = isBuy ? ltpAtTrigger.mul(0.995) : ltpAtTrigger.mul(1.005);
              const realizedPnl = isBuy ? slippedLtp.minus(entryPrice).mul(qty) : entryPrice.minus(slippedLtp).mul(qty);
              
              // Create exit with circuit limit flag
              const account = await getAccount();
              await db.transaction(async (tx) => {
                await tx.update(paperPositionsTable)
                  .set({
                    status: "CLOSED",
                    realizedPnl: realizedPnl.toFixed(2),
                    unrealizedPnl: "0.00",
                    closedAt: sql`now()`
                  })
                  .where(eq(paperPositionsTable.id, pos.id));

                await tx.insert(paperOrdersTable).values({
                  suggestionId: pos.suggestionId,
                  symbol: pos.symbol,
                  direction: isBuy ? "SELL" : "BUY",
                  orderType: "CIRCUIT_LIMIT_EXIT",
                  quantity: qty.toNumber(),
                  price: slippedLtp.toFixed(2),
                  status: "EXECUTED"
                });

                const releasedMargin = qty.mul(entryPrice).div(5);
                await tx.update(paperAccountsTable)
                  .set({ 
                    allocatedMargin: sql`GREATEST(0, allocated_margin - ${releasedMargin.toFixed(2)})`,
                    balance: sql`balance + ${realizedPnl.toFixed(2)}`
                  })
                  .where(eq(paperAccountsTable.id, account.id));
              });
              
              circuitLimitTracker.delete(pos.symbol);
              logger.warn({ symbol: pos.symbol, realizedPnl: realizedPnl.toNumber() }, "PaperEngine: Forced exit during circuit limit");
              continue;
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
          let slippedLtp: Decimal;
          
          if (isBuy) {
            // For BUY positions, we SELL on exit - slippage works against us
            slippedLtp = ltpAtTrigger.mul(0.9995); // 0.05% slippage down
          } else {
            // For SELL positions, we BUY on exit - slippage works against us
            slippedLtp = ltpAtTrigger.mul(1.0005); // 0.05% slippage up
          }
          
          const realizedPnl = isBuy ? slippedLtp.minus(entryPrice).mul(qty) : entryPrice.minus(slippedLtp).mul(qty);

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

            // 3. Update Account (release intraday 5x required margin cleanly without going below zero)
            const releasedMargin = qty.mul(entryPrice).div(5);
            await tx.update(paperAccountsTable)
              .set({ 
                allocatedMargin: sql`GREATEST(0, allocated_margin - ${releasedMargin.toFixed(2)})`,
                balance: sql`balance + ${realizedPnl.toFixed(2)}`
              })
              .where(eq(paperAccountsTable.id, account.id));
          });

          logger.info({ symbol: pos.symbol, exitReason, realizedPnl: realizedPnl.toNumber() }, "PaperEngine: Exited Position");
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
  });

  logger.info("PaperTrading Engine Initialized");
}
