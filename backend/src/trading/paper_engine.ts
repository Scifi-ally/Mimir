import { db } from "../../db/src";
import { eq, sql, gte } from "drizzle-orm";
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

async function getAccount() {
  let [account] = await db.select().from(paperAccountsTable).limit(1);
  if (!account) {
    [account] = await db.insert(paperAccountsTable).values({
      userId: "system",
      balance: "10000.00",
      startingBalance: "10000.00",
      allocatedMargin: "0.00"
    }).returning();
  }
  return account;
}

export async function initPaperEngine() {
  if (engineActive) return;
  engineActive = true;
  
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

      const todaysPositions = await db.select().from(paperPositionsTable).where(
        gte(paperPositionsTable.createdAt, todayStartUTC())
      );

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
      // Dynamic Position Sizing (Half-Kelly Criterion)
      // ---------------------------------------------------------
      const maxRiskCap = config.maxRiskPerTradePct || 2.0; // Hard cap at 2% risk

      // Derive Kelly variables
      // confidence is usually 0-100 (from compositeScore * 10), so divide by 100
      const winProb = (suggestion.confidence || 50) / 100; // 0.0 to 1.0 range
      const riskReward = Number(suggestion.riskReward) || 2.0; // Fallback to 1:2 if missing

      // Full Kelly = W - ( (1 - W) / R )
      const fullKelly = winProb - ((1.0 - winProb) / riskReward);
      
      // Use Half-Kelly for safety, if negative fallback to a base 1% risk rather than vetoing a top AI pick
      const kellyRiskPct = fullKelly > 0 ? (fullKelly * 100) / 2.0 : 1.0; 
      
      const riskPct = Math.min(Math.max(kellyRiskPct, 1.0), maxRiskCap); // Minimum 1% risk
      const riskAmount = balance.mul(riskPct).div(100);
      
      logger.info({ symbol: suggestion.symbol, winProb, riskReward, fullKelly, riskPct }, "PaperEngine: Sized trade");
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
      const stopDistance = entry.minus(stopLoss).abs();
      
      if (stopDistance.isZero() || stopDistance.isNaN()) {
        logger.debug({ symbol: suggestion.symbol, stopDistance: stopDistance.toNumber(), entry: entry.toNumber(), stopLoss: stopLoss.toNumber() }, "PaperEngine: Aborted entry due to invalid stopDistance");
        return;
      }

      // Calculate quantity, but guarantee at least 1 share if margin allows it
      let quantity = Decimal.max(1, riskAmount.div(stopDistance).floor()).toNumber();

      // Ensure we don't exceed available margin
      let requiredMargin = entry.mul(quantity);
      if (requiredMargin.gt(availableMargin)) {
        quantity = availableMargin.div(entry).floor().toNumber();
        requiredMargin = entry.mul(quantity); // Recalculate with new quantity
        if (quantity <= 0) {
          logger.warn({ symbol: suggestion.symbol, availableMargin: availableMargin.toNumber(), entry: entry.toNumber() }, "PaperEngine: Aborted entry because quantity is 0 after margin adjustment");
          return;
        }
      }

      await db.transaction(async (tx) => {
        // 1. Create Position
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

        // 2. Create Order
        await tx.insert(paperOrdersTable).values({
          suggestionId: suggestion.id,
          symbol: suggestion.symbol,
          direction: suggestion.direction,
          orderType: "ENTRY",
          quantity,
          price: entry.toFixed(2),
          status: "EXECUTED"
        });

        // 3. Update Account
        const updateRes = await tx.update(paperAccountsTable)
          .set({ allocatedMargin: sql`allocated_margin + ${requiredMargin.toFixed(2)}` })
          .where(sql`${paperAccountsTable.id} = ${account.id} AND balance - allocated_margin >= ${requiredMargin.toFixed(2)}`)
          .returning();
          
        if (updateRes.length === 0) {
          throw new Error("PaperEngine: Trade aborted due to insufficient margin or race condition");
        }
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

      const openPositions = await db.select().from(paperPositionsTable)
        .where(eq(paperPositionsTable.status, "OPEN"));

      const positionsForSymbol = openPositions.filter(p => p.symbol === tick.symbol);
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
        const target = new Decimal(suggestion.target1 ?? (suggestion as any).target ?? "0");

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
          // Circuit limit guard: If volume is 0 or bid/ask is missing when trying to exit, it means liquidity vanished (circuit hit).
          if (tick.volume === 0 || (isBuy && tick.bid === 0) || (!isBuy && tick.ask === 0)) {
            logger.warn({ symbol: pos.symbol, exitReason, bid: tick.bid, ask: tick.ask }, "PaperEngine: Deferred exit due to suspected circuit limit or zero liquidity");
            continue;
          }

           let slippedLtp = ltp;
           if (isBuy) {
              if (exitReason === "STOP_EXIT") slippedLtp = currentStop.mul(0.9995);
              else if (exitReason === "TARGET_EXIT") slippedLtp = target.mul(0.9995);
           } else {
              if (exitReason === "STOP_EXIT") slippedLtp = currentStop.mul(1.0005);
              else if (exitReason === "TARGET_EXIT") slippedLtp = target.mul(1.0005);
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

            // 3. Update Account
            const requiredMargin = qty.mul(entryPrice);
            await tx.update(paperAccountsTable)
              .set({ 
                allocatedMargin: sql`allocated_margin - ${requiredMargin.toFixed(2)}`,
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
