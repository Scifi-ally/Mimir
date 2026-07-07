import { db, suggestionsTable } from "../../db/src";
import { eq } from "drizzle-orm";
import { intelligenceBus } from "../intelligence/event_bus";
import { getConfig } from "../config";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { logger } from "../lib/logger";
import type { Suggestion } from "../../db/src/schema/suggestions";

let activePositions: Suggestion[] = [];
const processingLocks = new Map<string, Promise<void>>();

async function refreshActivePositions() {
  try {
    activePositions = await db
      .select()
      .from(suggestionsTable)
      .where(eq(suggestionsTable.status, "ACTIVE"));
  } catch (err) {
    logger.error({ err }, "PositionTracker: Failed to refresh active positions");
  }
}

export async function initPositionTracker() {
  await refreshActivePositions();
  
  // Refresh every 5 seconds to stay in sync with database updates
  const intervalId = setInterval(() => {
    void refreshActivePositions();
  }, 5000);

  // Subscribe to market ticks
  const unsubscribe = intelligenceBus.subscribe("processedTick", (tick) => {
    const symbol = tick.symbol;
    const lock = processingLocks.get(symbol) || Promise.resolve();

    const nextLock = lock.then(async () => {
      try {
        const positionsForSymbol = activePositions.filter(
          (p) => p.symbol === symbol
        );
        if (positionsForSymbol.length === 0) return;

      const stopLossMode = getConfig().stopLossMode;
      
      for (const pos of positionsForSymbol) {
        const ltp = tick.ltp;
        const entryPrice = parseFloat(pos.entryPrice);
        const currentStop = parseFloat(pos.stopLoss);
        const target1 = parseFloat(pos.target1);
        
        let highestPrice = pos.highestPrice ? parseFloat(pos.highestPrice) : entryPrice;
        let lowestPrice = pos.lowestPrice ? parseFloat(pos.lowestPrice) : entryPrice;

        let highLowChanged = false;
        if (ltp > highestPrice) {
          highestPrice = ltp;
          highLowChanged = true;
        }
        if (ltp < lowestPrice || lowestPrice === 0) {
          lowestPrice = ltp;
          highLowChanged = true;
        }

        if (stopLossMode === "FIXED") {
          // Under FIXED mode, just track the high/low
          if (highLowChanged) {
            await db
              .update(suggestionsTable)
              .set({
                highestPrice: highestPrice.toFixed(2),
                lowestPrice: lowestPrice.toFixed(2),
              })
              .where(eq(suggestionsTable.id, pos.id));

            pos.highestPrice = highestPrice.toFixed(2);
            pos.lowestPrice = lowestPrice.toFixed(2);
          }
          continue;
        }

        const stopDistPct = pos.stopDistancePct ? parseFloat(pos.stopDistancePct) : 1.5;
        const stopDistance = entryPrice * (stopDistPct / 100);
        const originalStopLoss = pos.direction === "BUY" ? entryPrice - stopDistance : entryPrice + stopDistance;
        const atrVal = pos.atr ? parseFloat(pos.atr) : stopDistance / 1.5;

        let newStop = currentStop;

        if (stopLossMode === "TRAILING") {
          if (pos.direction === "BUY") {
            const trailStop = highestPrice - 1.5 * atrVal;
            if (trailStop > currentStop) {
              newStop = Math.round(trailStop * 100) / 100;
            }
          } else if (pos.direction === "SELL") {
            const trailStop = lowestPrice + 1.5 * atrVal;
            if (trailStop < currentStop) {
              newStop = Math.round(trailStop * 100) / 100;
            }
          }
        } else if (stopLossMode === "BREAKEVEN") {
          if (pos.direction === "BUY") {
            const profitTarget = entryPrice + (entryPrice - originalStopLoss);
            if (ltp >= profitTarget && currentStop < entryPrice) {
              newStop = entryPrice;
            }
          } else if (pos.direction === "SELL") {
            const profitTarget = entryPrice - (originalStopLoss - entryPrice);
            if (ltp <= profitTarget && currentStop > entryPrice) {
              newStop = entryPrice;
            }
          }
        }

        const stopChanged = newStop !== currentStop;

        if (stopChanged || highLowChanged) {
          await db
            .update(suggestionsTable)
            .set({
              stopLoss: newStop.toFixed(2),
              highestPrice: highestPrice.toFixed(2),
              lowestPrice: lowestPrice.toFixed(2),
            })
            .where(eq(suggestionsTable.id, pos.id));

          // Update local memory representation
          pos.stopLoss = newStop.toFixed(2);
          pos.highestPrice = highestPrice.toFixed(2);
          pos.lowestPrice = lowestPrice.toFixed(2);

          logger.info(
            {
              symbol: pos.symbol,
              stopLossMode,
              oldStop: currentStop,
              newStop,
              highestPrice,
              lowestPrice,
            },
            "PositionTracker: Updated stop loss and high/low"
          );

          // Broadcast websocket event
          broadcast(
            createServerEvent.positionUpdate({
              id: pos.id,
              symbol: pos.symbol,
              entryPrice,
              stopLoss: newStop,
              target1,
              direction: pos.direction as "BUY" | "SELL",
              mode: stopLossMode,
            })
          );
        }
      }
      } catch (err) {
        logger.error({ err, tick }, "PositionTracker: Error processing tick event");
      }
    });

    processingLocks.set(symbol, nextLock);

    nextLock.finally(() => {
      if (processingLocks.get(symbol) === nextLock) {
        processingLocks.delete(symbol);
      }
    });
  });

  return () => {
    clearInterval(intervalId);
    unsubscribe();
  };
}
