import { db, suggestionsTable } from "../../db/src";
import { eq, and } from "drizzle-orm";
import { intelligenceBus } from "../intelligence/event_bus";
import { getConfig } from "../config";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { logger } from "../lib/logger";
import type { Suggestion } from "../../db/src/schema/suggestions";

// CRITICAL FIX (Issue #2): Use immutable snapshot pattern to prevent concurrent modification
// The activePositions array is refreshed every 5 seconds, but tick processing can happen
// simultaneously. Instead of mutating the global array, we fetch fresh data per symbol.
const processingLocks = new Map<string, Promise<void>>();

// Background refresh for monitoring, but processing uses fresh DB queries
let activePositionsCache: Suggestion[] = [];

async function refreshActivePositions() {
  try {
    activePositionsCache = await db
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
        // Fast in-memory check to prevent excessive DB queries for symbols without active positions
        if (!activePositionsCache.some((pos) => pos.symbol === symbol)) return;

        // CRITICAL FIX (Issue #2): Fetch positions from DB directly instead of using
        // potentially stale activePositions array that gets replaced mid-processing
        const positionsForSymbol = await db
          .select()
          .from(suggestionsTable)
          .where(
            and(
              eq(suggestionsTable.symbol, symbol),
              eq(suggestionsTable.status, "ACTIVE")
            )
          );
        
        if (positionsForSymbol.length === 0) return;

      for (const pos of positionsForSymbol) {
        const stopLossMode = pos.stopLossMode || getConfig().stopLossMode;
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
            // CRITICAL FIX (Issue #2): Only update database, don't mutate cache
            await db
              .update(suggestionsTable)
              .set({
                highestPrice: highestPrice.toFixed(2),
                lowestPrice: lowestPrice.toFixed(2),
              })
              .where(eq(suggestionsTable.id, pos.id));
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
          // HIGH FIX (Issue #12): After setting breakeven, switch to TRAILING mode
          // Previously, stop stayed at breakeven forever - now it trails after breakeven is set
          if (pos.direction === "BUY") {
            const profitTarget = entryPrice + (entryPrice - originalStopLoss);
            if (ltp >= profitTarget && currentStop < entryPrice) {
              newStop = entryPrice;
              
              // Switch to TRAILING mode after breakeven is set
              await db
                .update(suggestionsTable)
                .set({ stopLossMode: "TRAILING" })
                .where(eq(suggestionsTable.id, pos.id));
              
              logger.info(
                { symbol: pos.symbol, newStop },
                "PositionTracker: Moved to breakeven, switching to TRAILING mode"
              );
            }
          } else if (pos.direction === "SELL") {
            const profitTarget = entryPrice - (originalStopLoss - entryPrice);
            if (ltp <= profitTarget && currentStop > entryPrice) {
              newStop = entryPrice;
              
              // Switch to TRAILING mode after breakeven is set
              await db
                .update(suggestionsTable)
                .set({ stopLossMode: "TRAILING" })
                .where(eq(suggestionsTable.id, pos.id));
              
              logger.info(
                { symbol: pos.symbol, newStop },
                "PositionTracker: Moved to breakeven, switching to TRAILING mode"
              );
            }
          }
        }

        const stopChanged = newStop !== currentStop;

        if (stopChanged || highLowChanged) {
          // CRITICAL FIX (Issue #2): Only update database, don't mutate in-memory array
          // Next refresh cycle will pick up the changes from DB
          await db
            .update(suggestionsTable)
            .set({
              stopLoss: newStop.toFixed(2),
              highestPrice: highestPrice.toFixed(2),
              lowestPrice: lowestPrice.toFixed(2),
            })
            .where(eq(suggestionsTable.id, pos.id));

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
