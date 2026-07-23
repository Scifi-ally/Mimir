import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeFeatureVector, toRankerFeatureArray } from './feature_engine';
import type { OHLCV, TechnicalSnapshot } from './technical';

describe('Feature Engine', () => {
  beforeEach(() => {
    vi.mock('../market_data/market_state', () => ({
      getMarketState: () => ({ topSectors: [] })
    }));
    vi.mock('./regime_detector', () => ({
      getLastRegimeOutput: () => ({ strength: 50 })
    }));
  });

  it('computes F&O/microstructure signals correctly', () => {
    const symbol = 'RELIANCE';
    const sector = 'ENERGY';
    
    // Minimal mock data for candles and snapshot
    const mockCandles: OHLCV[] = Array.from({ length: 30 }).map((_, i) => ({
      timestamp: new Date().toISOString(),
      open: 100,
      high: 105,
      low: 95,
      close: 100 + i, // slight uptrend
      volume: 1000,
    }));
    
    const mockSnap: TechnicalSnapshot = {
      close: 130,
      ema9: 125,
      ema20: 120,
      ema50: 110,
      ema200: 100,
      rsi14: 60,
      atr14: 5,
      volumeRatio: 1.2,
      adx14: 25,
      high52w: 150,
      low52w: 80,
      distFromEma20Pct: 5,
      trend: "UP",
      avgDailyVolume: 1000,
      swingLow: 90,
      swingHigh: 140,
      vwap: 120,
      superTrend: 1,
      vpvrPOC: 115,
      volumeAnomaly: false,
    };
    
    const fv = computeFeatureVector(
      symbol,
      sector,
      mockCandles,
      mockSnap,
      1.1, // rsVsNifty
      1.05, // rsVsSector
      2.5, // riskReward
      0.45, // bidAskImbalance
      12.5, // optionsOiChangeRate
      150.5 // fiiDiiNetFlowLag
    );

    expect(fv.bidAskImbalance).toBe(0.45);
    expect(fv.optionsOiChangeRate).toBe(12.5);
    expect(fv.fiiDiiNetFlowLag).toBe(150.5);

    // Verify it is part of the ranker feature array
    const rankerArray = toRankerFeatureArray(fv);
    
    // Get indexes based on RANKER_FEATURE_KEYS length to ensure they are added correctly
    // Since rankerArray maps precisely to RANKER_FEATURE_KEYS
    expect(rankerArray[rankerArray.length - 3]).toBe(0.45);
    expect(rankerArray[rankerArray.length - 2]).toBe(12.5);
    expect(rankerArray[rankerArray.length - 1]).toBe(150.5);
  });
});
