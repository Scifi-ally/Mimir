import type { FeatureVector } from "./feature_engine";

/**
 * Single source of truth for the 32 features consumed by the learned ranker.
 * This module intentionally has no runtime dependency on market state, database,
 * regime detection, or indicator computation.
 */
export const RANKER_FEATURE_KEYS = [
  "rsi14",
  "atr14",
  "atrPct",
  "adx14",
  "volumeRatio",
  "vwapDistance",
  "ema20Dist",
  "ema50Dist",
  "ema200Dist",
  "emaAlignment",
  "trendConsistency",
  "rsVsNifty60d",
  "rsVsSector60d",
  "pocDistancePct",
  "bbWidthPct",
  "vcpContraction",
  "momentumScore",
  "trendScore",
  "volatilityScore",
  "riskRewardScore",
  "priceRoc5",
  "priceRoc10",
  "priceRoc20",
  "bodyRatio",
  "upperWickRatio",
  "lowerWickRatio",
  "closeLocation",
  "realizedVol5",
  "realizedVol20",
  "volOfVol",
  "cprWidthPct",
  "fiiDiiNetFlowLag",
] as const satisfies readonly (keyof FeatureVector)[];

export type RankerFeatureKey = (typeof RANKER_FEATURE_KEYS)[number];

export function toRankerFeatureArray(fv: FeatureVector): number[] {
  if (fv.rankerIncomplete) {
    throw new Error(
      `toRankerFeatureArray: refusing to score ranker-incomplete feature vector ` +
      `for ${fv.symbol} (tick-derived / placeholder features). Use the full ` +
      `candle-history feature engine before ranking.`,
    );
  }
  return RANKER_FEATURE_KEYS.map((key) => {
    const value = fv[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  });
}
