import { db } from "../../db/src";
import { customScreenerTable } from "../../db/src/schema/custom_screener";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { runCustomScreener } from "../analysis/custom_screener_engine";
import { getAccessToken } from "../upstox/auth";

export async function evaluateCustomScreenerSchedules() {
  try {
    const token = getAccessToken();
    if (!token) return;

    const screeners = await db.select().from(customScreenerTable).where(eq(customScreenerTable.status, "ACTIVE"));
    
    const now = new Date();
    const istOffset = 330 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset);
    const hour = istTime.getUTCHours();
    const minute = istTime.getUTCMinutes();
    const timeStr = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
    
    const idsToRun: number[] = [];

    for (const screener of screeners) {
      let shouldRun = false;

      if (screener.scheduleMode === "EVERY_MINUTE") {
        shouldRun = true;
      } else if (screener.scheduleMode === "EVERY_CANDLE") {
        if (screener.timeframe === "1m") {
          shouldRun = true;
        } else if (screener.timeframe === "5m" && minute % 5 === 0) {
          shouldRun = true;
        } else if (screener.timeframe === "15m" && minute % 15 === 0) {
          shouldRun = true;
        } else if (screener.timeframe === "1h" && minute === 15) {
          // 60-minute candles in Indian market close at 10:15, 11:15, etc.
          shouldRun = true;
        } else if (screener.timeframe === "1d" && timeStr === "15:30") {
          shouldRun = true;
        }
      } else if (screener.scheduleMode === "TIME" && screener.scheduleTime === timeStr) {
        shouldRun = true;
      } else if (screener.scheduleMode === "MARKET_OPEN" && timeStr === "09:16") {
        // Wait 1 minute after open for the first candle to print or ticks to settle
        shouldRun = true;
      } else if (screener.scheduleMode === "MARKET_CLOSE" && timeStr === "15:30") {
        shouldRun = true;
      }

      if (shouldRun) {
        idsToRun.push(screener.id);
      }
    }

    if (idsToRun.length > 0) {
      logger.info({ count: idsToRun.length, timeStr }, "Triggering scheduled custom screeners");
      // Execute asynchronously
      runCustomScreener({ screenerIds: idsToRun }).catch(err => {
        logger.error({ err }, "Error running scheduled custom screeners");
      });
    }

  } catch (err) {
    logger.error({ err }, "Error evaluating custom screener schedules");
  }
}
