import { describe, it, expect } from "vitest";
import {
  evaluateStockChampionProfile,
  getStockChampion,
  getAllStockChampions,
  getStockStrategyAffinity,
} from "../src/analysis/stock_strategy_matrix";
import type { OHLCV } from "../src/analysis/technical";

describe("Stock Strategy Matrix & Factor Affinity Engine", () => {
  function generateMockCandles(count: number, basePrice = 1000, trend = 0.5): OHLCV[] {
    const candles: OHLCV[] = [];
    let price = basePrice;
    for (let i = 0; i < count; i++) {
      const open = price;
      price += trend + (Math.sin(i / 5) * 2.5);
      const close = price;
      const high = Math.max(open, close) + 3;
      const low = Math.min(open, close) - 3;
      candles.push({
        timestamp: new Date(Date.now() - (count - i) * 86400000).toISOString(),
        open: parseFloat(open.toFixed(2)),
        high: parseFloat(high.toFixed(2)),
        low: parseFloat(low.toFixed(2)),
        close: parseFloat(close.toFixed(2)),
        volume: 250000 + (i % 7) * 25000,
      });
    }
    return candles;
  }

  describe("evaluateStockChampionProfile", () => {
    it("should evaluate a stock across strategy matrix and return champion profile", () => {
      const candles = generateMockCandles(120, 1500, 1.2);
      const profile = evaluateStockChampionProfile("TEST_STOCK", candles);

      expect(profile).toBeDefined();
      expect(profile.symbol).toBe("TEST_STOCK");
      expect(profile.totalStrategiesEvaluated).toBeGreaterThanOrEqual(10);
      expect(profile.championStrategy).toBeDefined();
      expect(profile.championStrategy.strategyName).toBeTruthy();
      expect(profile.championStrategy.family).toBeTruthy();
      expect(profile.championStrategy.profitFactor).toBeGreaterThanOrEqual(0);
      expect(profile.championStrategy.winRatePct).toBeGreaterThanOrEqual(0);
      expect(profile.affinityWeight).toBeGreaterThanOrEqual(0.7);
      expect(profile.affinityWeight).toBeLessThanOrEqual(1.4);
      expect(profile.preferredIndicators.length).toBeGreaterThan(0);
    });

    it("should handle stocks with flat/choppy movement gracefully", () => {
      const candles = generateMockCandles(80, 500, 0);
      const profile = evaluateStockChampionProfile("CHOP_STOCK", candles);

      expect(profile.symbol).toBe("CHOP_STOCK");
      expect(profile.championStrategy).toBeDefined();
      expect(typeof profile.championStrategy.profitFactor).toBe("number");
      expect(typeof profile.affinityWeight).toBe("number");
    });
  });

  describe("Registry Lookups and Normalization", () => {
    it("should retrieve pre-computed champions from persistent registry", () => {
      const championsMap = getAllStockChampions();
      const champions = Object.values(championsMap);
      expect(champions.length).toBeGreaterThanOrEqual(80);

      const reliance = getStockChampion("RELIANCE");
      expect(reliance).toBeDefined();
      if (reliance) {
        expect(reliance.symbol).toBe("RELIANCE");
        expect(reliance.championStrategy.strategyName).toBeTruthy();
        expect(reliance.championStrategy.profitFactor).toBeGreaterThan(0);
        expect(reliance.preferredIndicators.length).toBeGreaterThan(0);
      }
    });

    it("should normalize Upstox instrument keys to ticker symbols", () => {
      const direct = getStockChampion("RELIANCE");
      if (direct) {
        expect(direct.symbol).toBe("RELIANCE");
      }
      const withPrefix = getStockChampion("NSE_EQ|RELIANCE");
      if (direct) {
        expect(withPrefix?.symbol).toBe("RELIANCE");
      }
    });

    it("should return null for non-existent stock symbols", () => {
      const nonExistent = getStockChampion("NON_EXISTENT_TICKER_XYZ999");
      expect(nonExistent).toBeNull();
    });
  });

  describe("getStockStrategyAffinity & Dynamic Weightage", () => {
    it("should grant quality score adjustment and confidence boost for champion strategy", () => {
      const reliance = getStockChampion("RELIANCE");
      expect(reliance).toBeDefined();
      if (!reliance) return;

      const champStrategyId = reliance.championStrategy.strategyId;
      const affinity = getStockStrategyAffinity("RELIANCE", champStrategyId);

      expect(affinity.symbol).toBe("RELIANCE");
      expect(affinity.isChampion).toBe(true);
      expect(affinity.qualityScoreAdjustment).toBeGreaterThan(0);
      expect(affinity.pipelineConfidenceBoost).toBeGreaterThan(0);
    });

    it("should return neutral weightage for unknown stocks", () => {
      const affinity = getStockStrategyAffinity("UNKNOWN_XYZ", "random_setup");
      expect(affinity.familyAffinityScore).toBe(1.0);
      expect(affinity.qualityScoreAdjustment).toBe(0);
      expect(affinity.pipelineConfidenceBoost).toBe(0);
      expect(affinity.isChampion).toBe(false);
    });

    it("should provide family-level affinity boost for setups in same strategy family", () => {
      const champions = Object.values(getAllStockChampions());
      expect(champions.length).toBeGreaterThan(0);

      const profile = champions[0]!;
      const family = profile.championStrategy.family;

      // Pass generic setup belonging to that family
      const affinity = getStockStrategyAffinity(profile.symbol, family);
      expect(affinity.symbol).toBe(profile.symbol);
      expect(typeof affinity.familyAffinityScore).toBe("number");
      expect(typeof affinity.qualityScoreAdjustment).toBe("number");
      expect(affinity.isChampion).toBe(true);
    });
  });
});
