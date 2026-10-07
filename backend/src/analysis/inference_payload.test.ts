import { describe, expect, it } from "vitest";
import { toBatchInferenceCandidate } from "./inference_payload";
import type { FeatureVector } from "./feature_engine";
import { RANKER_FEATURE_KEYS } from "./ranker_contract";

// Built FROM RANKER_FEATURE_KEYS rather than hand-written.
//
// This fixture used to list features by their old names (rsi, atr, ema9Distance,
// priceRoc, bollingerWidth, cprWidth, fiiDiiFlowLag) - none of which the ranker
// has read for some time. Every one of those silently became 0 through the
// zero-fill in toRankerFeatureArray, so the test asserted a correct-looking
// 32-wide payload while 19 columns were fiction.
//
// Deriving it from the contract means a future key change fails the build rather
// than quietly widening this fixture's fiction.
function featureVector(overrides: Partial<FeatureVector> = {}): FeatureVector {
  const base = Object.fromEntries(
    RANKER_FEATURE_KEYS.map((key, i) => [key, (i + 1) / 100]),
  );
  return {
    ...base,
    symbol: "RELIANCE",
    sector: "Energy",
    timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
    // Context the inference payload reads, not model features.
    bidAskImbalance: 0.2,
    optionsOiChangeRate: 0.1,
    sectorStrength: 0.5,
    regimeScore: 70,
    rankerIncomplete: false,
    ...overrides,
} as unknown as FeatureVector;
}

describe("inference payload boundary", () => {
  it("preserves missing market measurements instead of inventing neutral values", () => {
    const payload = toBatchInferenceCandidate({ symbol: "RELIANCE", candles: [],
      features: featureVector({ bidAskImbalance: null, optionsOiChangeRate: null, fiiDiiNetFlowLag: NaN }) });
    expect(payload.features.vix).toBeNull();
    expect(payload.features.india_vix).toBeNull();
    expect(payload.features.ofi_ratio).toBeNull();
    expect(payload.features.optionsOiChangeRate).toBeNull();
    expect(payload.features.fii_dii_net).toBeNull();
  });
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
