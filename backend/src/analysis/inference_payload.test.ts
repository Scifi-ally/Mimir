import { describe, expect, it } from "vitest";
import { toBatchInferenceCandidate } from "./inference_payload";
import type { FeatureVector } from "./feature_engine";

function featureVector(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    rsi: 55,
    atr: 2,
    adx: 20,
    volumeRatio: 1.2,
    vwapDistance: 0.01,
    ema9Distance: 0.02,
    ema21Distance: 0.03,
    ema50Distance: 0.04,
    ema200Distance: 0.05,
    emaAlignment: 1,
    trendConsistency: 0.7,
    rsVsNifty60d: 1.05,
    rsVsSector: 1.01,
    pocDistance: 0.02,
    bollingerWidth: 0.1,
    vcpContraction: 0.4,
    momentumScore: 70,
    trendScore: 65,
    volatilityScore: 50,
    riskReward: 2,
    priceRoc: 0.03,
    upperWickRatio: 0.1,
    lowerWickRatio: 0.2,
    bodyRatio: 0.6,
    realizedVolatility: 0.02,
    volOfVol: 0.01,
    cprWidth: 0.03,
    fiiDiiFlowLag: 10,
    bidAskImbalance: 0.2,
    optionsOiChangeRate: 0.1,
    rankerIncomplete: false,
    sectorStrength: 0.5,
    regimeScore: 70,
    ...overrides,
  } as FeatureVector;
}

describe("inference payload boundary", () => {
  it("preserves OHLCV column order and emits ranker features", () => {
    const payload = toBatchInferenceCandidate({
      symbol: "RELIANCE",
      candles: [{ timestamp: "2026-01-01T00:00:00.000Z", open: 100, high: 105, low: 98, close: 103, volume: 1000 }],
      features: featureVector(),
    });

    expect(payload.symbol).toBe("RELIANCE");
    expect(payload.ohlcv).toEqual([[100, 105, 98, 103, 1000]]);
    expect(payload.features.ranker_features).toHaveLength(32);
  });

  it("does not fabricate ranker features for incomplete realtime data", () => {
    const payload = toBatchInferenceCandidate({
      symbol: "INFY",
      candles: [{ timestamp: "2026-01-01T00:00:00.000Z", open: 100, high: 101, low: 99, close: 100.5, volume: 500 }],
      features: featureVector({ rankerIncomplete: true }),
    });

    expect(payload.features.ranker_features).toBeNull();
  });
});
