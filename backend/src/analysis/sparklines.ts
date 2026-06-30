import yahooFinance from "yahoo-finance2";
import { logger } from "../lib/logger";

export async function fetchSparklines(symbols: string[]): Promise<Record<string, number[]>> {
  const results: Record<string, number[]> = {};

  // Process in batches of 10 to avoid rate limiting
  for (let i = 0; i < symbols.length; i += 10) {
    const batch = symbols.slice(i, i + 10);
    const promises = batch.map(async (symbol) => {
      try {
        // Map Indian symbols to Yahoo Finance format
        const yfSymbol = symbol === "NIFTY 50" ? "^NSEI" 
          : symbol === "BANKNIFTY" ? "^NSEBANK" 
          : symbol === "SENSEX" ? "^BSESN"
          : symbol.endsWith(".NS") || symbol.endsWith(".BO") ? symbol 
          : `${symbol}.NS`;

        const queryOptions = { period1: "1mo", interval: "1d" as const };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (await yahooFinance.chart(yfSymbol, queryOptions)) as any;
        
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

    await Promise.all(promises);
  }

  return results;
}
