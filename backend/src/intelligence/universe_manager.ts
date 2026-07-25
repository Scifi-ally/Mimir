import axios from "axios";
import { getEffectiveUniverse, type UniverseStock } from "../analysis/stock_scanner";
import { getAccessToken } from "../upstox/auth";
import { logger } from "../lib/logger";
import { intelligenceConfig } from "./config";
import { withRetry } from "../lib/upstox-client";

export class UniverseManager {
  private universe: UniverseStock[] = [];
  private updatedAt = 0;

  async refresh(): Promise<UniverseStock[]> {
    try {
      const raw = await getEffectiveUniverse();
      const token = getAccessToken();
      
      // Filter out basic invalid names first (ETFs, Mutual Funds, Liquid bees)
      const initialFiltered = raw.filter((stock) => 
        stock.key && 
        stock.symbol && 
        !/ETF|BEES|LIQUID|GILT|MUTUAL|INF/i.test(`${stock.symbol} ${stock.name}`)
      );

      if (!token) {
        logger.warn("No token available in UniverseManager; using fallback alphabetical filtering");
        this.universe = initialFiltered.slice(0, intelligenceConfig.maxUniverseSize);
        this.updatedAt = Date.now();
        return this.universe;
      }

      logger.info({ totalCandidates: initialFiltered.length }, "Fetching quotes to filter universe by volume and liquidity");

      const batchSize = 50;
      const liquidStocks: UniverseStock[] = [];

      for (let i = 0; i < initialFiltered.length; i += batchSize) {
        const batch = initialFiltered.slice(i, i + batchSize);
        const keys = batch.map(s => s.key).join(",");

        try {
          const response = await withRetry(
            () => axios.get("https://api.upstox.com/v2/market-quote/quotes", {
              params: { instrument_key: keys },
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
              },
              timeout: 8000,
            }),
            `Universe Quotes Query Batch (${batch.length} instruments)`,
            { maxRetries: 3, baseDelayMs: 200, maxDelayMs: 5000 }
          );

          const quotes = response.data?.data || {};

          for (const stock of batch) {
            const quote = quotes[stock.key];
            if (!quote) continue;

            const ltp = Number(quote.last_price || 0);
            const volume = Number(quote.volume || 0);

            // Filter out suspended stocks (ltp = 0)
            if (ltp <= 0) continue;

            // Filter penny stocks (ltp < 20) and ultra-expensive illiquid stocks (ltp > 20000)
            if (ltp < 20 || ltp > 20000) continue;

            // Filter out illiquid stocks (volume < 50,000 shares)
            if (volume < 50000) continue;

            liquidStocks.push(stock);
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          logger.debug({ error: err.message, index: i }, "Failed to fetch quotes batch for universe filtering");
          // If we hit rate limits or errors, we add the current batch as fallback so we don't drop valid stocks
          for (const stock of batch) {
            liquidStocks.push(stock);
          }
        }

        // Stagger requests slightly to be nice to Upstox API
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // If we filtered out too many or had API failures, make sure we have at least minUniverseSize
      if (liquidStocks.length < intelligenceConfig.minUniverseSize) {
        logger.warn({ liquidCount: liquidStocks.length, min: intelligenceConfig.minUniverseSize }, "Filtered universe too small; fallback to alphabetical slice");
        this.universe = initialFiltered.slice(0, intelligenceConfig.maxUniverseSize);
      } else {
        this.universe = liquidStocks.slice(0, intelligenceConfig.maxUniverseSize);
      }

      logger.info({ finalUniverseSize: this.universe.length }, "Universe refreshed successfully");
      this.updatedAt = Date.now();
      return this.universe;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.error({ err }, "Failed to refresh universe in UniverseManager");
      // Hard fallback
      this.universe = (await getEffectiveUniverse(intelligenceConfig.maxUniverseSize))
        .filter((stock) => stock.key && stock.symbol && !/ETF|BEES|LIQUID/i.test(`${stock.symbol} ${stock.name}`));
      this.updatedAt = Date.now();
      return this.universe;
    }
  }

  getUniverse(): UniverseStock[] {
    return [...this.universe];
  }

  getUpdatedAt(): number {
    return this.updatedAt;
  }
}
