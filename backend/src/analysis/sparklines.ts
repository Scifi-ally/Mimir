import yahooFinance from "yahoo-finance2";
import { logger } from "../lib/logger";

export async function fetchSparklines(symbols: string[]): Promise<Record<string, number[]>> {
  const results: Record<string, number[]> = {};

  // Process all concurrently, Yahoo Finance API can handle reasonable bursts
  const promises = symbols.map(async (symbol) => {
    try {
      // Map Indian symbols to Yahoo Finance format
      const yfSymbol = symbol === "NIFTY 50" ? "^NSEI" 
        : symbol === "BANKNIFTY" ? "^NSEBANK" 
        : symbol === "SENSEX" ? "^BSESN"
        : symbol.endsWith(".NS") || symbol.endsWith(".BO") ? symbol 
        : `${symbol}.NS`;

      const queryOptions = { period1: "1mo", interval: "1d" as const };

      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise((_, reject) => 
        timer = setTimeout(() => reject(new Error("Yahoo Finance timeout")), 1500)
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
        results[symbol] = closes.slice(-20);
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger.debug({ symbol, err: (err as any).message }, "Failed to fetch sparkline from Yahoo Finance");
    }
  });

  await Promise.allSettled(promises);
  return results;
}
