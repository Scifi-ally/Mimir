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
// A missing feature used to be silently coerced to 0, which made "never
    // measured" indistinguishable from "measured as exactly neutral" - the same
    // class of dishonesty that let rsVsSector60d train as a constant while the
    // shipped model kept splitting on it 13 times.
    //
    // It is now refused outright, and every offender is named. A prediction the
    // system cannot actually compute must not come out of it as a confident
    // number; it is better to abstain and say which input was absent.
    const missing: RankerFeatureKey[] = [];
    const row = RANKER_FEATURE_KEYS.map((key) => {
      const value = fv[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      missing.push(key);
      return 0;
    });
    if (missing.length > 0) {
      throw new Error(
        `toRankerFeatureArray: refusing to score ${fv.symbol} with ` +
          `${missing.length}/${RANKER_FEATURE_KEYS.length} unmeasured feature(s): ` +
          `${missing.join(", ")}. Substituting 0 would report an unmeasured input ` +
          `as a measured neutral one.`,
      );
    }
    return row;
  }
