import yahooFinance from "yahoo-finance2";
import { logger } from "../lib/logger";
import { findStockBySymbol } from "./stock_scanner";
import { createUpstoxClient } from "../lib/upstox-client";
import { getAccessToken } from "../upstox/auth";
import { getISTDateStr } from "../lib/ist-time";

const upstoxClient = createUpstoxClient({ cacheTimeMs: 15_000 });

export async function fetchSparklines(symbols: string[]): Promise<Record<string, number[]>> {
  const results: Record<string, number[]> = {};
  const token = getAccessToken();
  const toDate = getISTDateStr();
  const fromDateObj = new Date();
  fromDateObj.setDate(fromDateObj.getDate() - 35);
  const fromDate = fromDateObj.toISOString().split("T")[0];

  // Process all concurrently, Yahoo Finance API can handle reasonable bursts
  const promises = symbols.map(async (symbol) => {
    try {
      // Map Indian symbols to Yahoo Finance format
      const yfSymbol = symbol === "NIFTY 50" ? "^NSEI" 
        : symbol === "BANKNIFTY" ? "^NSEBANK" 
        : symbol === "SENSEX" ? "^BSESN"
        : symbol.endsWith(".NS") || symbol.endsWith(".BO") ? symbol 
        : `${symbol}.NS`;

      const queryOptions = { period1: fromDate, interval: "1d" as const };

      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise((_, reject) => 
        timer = setTimeout(() => reject(new Error("Yahoo Finance timeout")), 5000)
      );
      timeoutPromise.catch(() => {});
      
      const result = (await Promise.race([
        yahooFinance.chart(yfSymbol, queryOptions),
        timeoutPromise
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ])) as any;
      
      clearTimeout(timer!);
      
      if (result && result.quotes && result.quotes.length > 0) {
        const closes = result.quotes
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((q: any) => q.close)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((c: any): c is number => typeof c === 'number' && c > 0);
        
        // Return the last 20 closing prices for the sparkline
        if (closes.length > 0) {
          results[symbol] = closes.slice(-20);
          return;
        }
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger.debug({ symbol, err: (err as any).message }, "Failed to fetch sparkline from Yahoo Finance, attempting Upstox fallback");
    }

    // Upstox Fallback if Yahoo Finance timed out or returned no data
    if (token) {
      try {
        const stock = await findStockBySymbol(symbol);
        if (stock) {
          const rawCandles = await upstoxClient.fetchHistoricalCandles(
            stock.key,
            "day",
            toDate,
            fromDate,
            token
          );
          if (Array.isArray(rawCandles) && rawCandles.length > 0) {
            // Upstox candles: [ts, open, high, low, close, volume] sorted newest first or oldest first depending on API
            // Let's sort ascending by timestamp just in case
            const sorted = [...rawCandles].sort((a, b) => new Date(String(a[0])).getTime() - new Date(String(b[0])).getTime());
            const closes = sorted
              .map((c) => Number(c[4]))
              .filter((c) => !isNaN(c) && c > 0);
            if (closes.length > 0) {
              results[symbol] = closes.slice(-20);
            }
          }
        }
      } catch (fbErr) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger.debug({ symbol, err: (fbErr as any).message }, "Upstox sparkline fallback failed");
      }
    }
  });

  await Promise.allSettled(promises);
  return results;
}
