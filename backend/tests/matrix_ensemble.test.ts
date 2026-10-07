import { describe, it, expect } from "vitest";
import { detectMatrixEnsembleSetup } from "../src/analysis/setups/matrix_ensemble";
import type { OHLCV, TechnicalSnapshot } from "../src/analysis/technical";

describe("Matrix Ensemble Multi-Factor Setup Detector", () => {
  function generateMockCandles(count: number, basePrice = 1000, trend = 0.5): OHLCV[] {
    const candles: OHLCV[] = [];
    let price = basePrice;
    for (let i = 0; i < count; i++) {
      const open = price;
      price += trend + (Math.sin(i / 5) * 2);
      const close = price;
      const high = Math.max(open, close) + 4;
      const low = Math.min(open, close) - 4;
      candles.push({
        timestamp: new Date(Date.now() - (count - i) * 86400000).toISOString(),
        open: parseFloat(open.toFixed(2)),
        high: parseFloat(high.toFixed(2)),
        low: parseFloat(low.toFixed(2)),
        close: parseFloat(close.toFixed(2)),
        volume: 250000,
      });
    }
    return candles;
  }

  function createMockSnapshot(overrides: Partial<TechnicalSnapshot> = {}): TechnicalSnapshot {
    return {
      close: 1200,
      ema9: 1190,
      ema20: 1180,
      ema50: 1150,
      ema200: 1050, // Macro bull trend
      rsi14: 48,
      atr14: 15,
      volumeRatio: 1.3,
      adx14: 26,
      high52w: 1300,
      low52w: 900,
      distFromEma20Pct: 1.2,
      trend: "UP",
      avgDailyVolume: 300000,
      swingLow: 1175,
      swingHigh: 1220,
      vwap: 1195,
      superTrend: 1170,
      vpvrPOC: 1180,
      volumeAnomaly: false,
      ...overrides,
    };
  }

  it("should return null if candles count is insufficient (< 55)", () => {
    const candles = generateMockCandles(40);
    const snap = createMockSnapshot();
    const result = detectMatrixEnsembleSetup(candles, snap);
    expect(result).toBeNull();
  });

  it("should reject long setup if stock is below EMA 200 (macro bear filter)", () => {
    const candles = generateMockCandles(60, 1000, 1.0);
    const snap = createMockSnapshot({
      close: 950,
      ema200: 1050, // Price is below EMA 200
      ema50: 1000,
      trend: "DOWN",
    });
    const result = detectMatrixEnsembleSetup(candles, snap);
    expect(result).toBeNull();
  });

  it("should detect Long Ensemble setup when Trend (EMA 5/50) and RSI/MACD champions align", () => {
    // Generate 60 ascending candles with mild pullback and bounce
    const candles = generateMockCandles(60, 1000, 1.0);
    candles[56]!.close = 1195;
    candles[57]!.close = 1190;
    candles[58]!.close = 1188;
    candles[59]!.open = 1189;
    candles[59]!.low = 1185;
    candles[59]!.close = 1205;
    candles[59]!.high = 1210;

    const snap = createMockSnapshot({
      close: 1205,
      ema20: 1190,
      ema50: 1150,
      ema200: 1050,
      rsi14: 48,
      atr14: 12,
      distFromEma20Pct: 1.2,
      volumeRatio: 1.35,
    });

    const result = detectMatrixEnsembleSetup(candles, snap);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.setupType).toBe("MATRIX_ENSEMBLE");
      expect(result.direction).toBe("BUY");
      expect(result.score).toBeGreaterThanOrEqual(7.5);
      expect(result.riskReward).toBeGreaterThanOrEqual(1.8);
      expect(result.confluence.length).toBeGreaterThanOrEqual(2);
      expect(result.stopLoss).toBeLessThan(result.entryPrice);
      expect(result.target1).toBeGreaterThan(result.entryPrice);
    }
  });

  it("should trigger Grand Champion Deep Oversold Rebound when RSI dips and hooks back up above EMA 200", () => {
    const candles = generateMockCandles(60, 1000, 1.0);
    // Simulate deep oversold dip in the last few candles followed by green rebound hook
    candles[candles.length - 3]!.close = 1100;
    candles[candles.length - 2]!.close = 1090;
    candles[candles.length - 1]!.open = 1092;
    candles[candles.length - 1]!.close = 1105; // Green rebound candle

    const snap = createMockSnapshot({
      close: 1105,
      ema20: 1120,
      ema50: 1110,
      ema200: 1050, // Firmly above EMA 200
      rsi14: 32,    // Oversold hook
      atr14: 14,
      volumeRatio: 1.4,
    });

    const result = detectMatrixEnsembleSetup(candles, snap);
    if (result) {
      expect(result.setupType).toBe("MATRIX_ENSEMBLE");
      expect(result.direction).toBe("BUY");
      expect(result.confluence.some((c) => c.includes("RSI(14)") || c.includes("MATRIX ENSEMBLE"))).toBe(true);
    }
  });
});
