import type { BatchInferenceCandidate } from "./ai_client";
import { toRankerFeatureArray } from "./ranker_contract";
import type { FeatureVector } from "./feature_engine";
import type { OHLCV } from "./technical";

export interface InferenceCandidateContext {
  symbol: string;
  candles: OHLCV[];
  features: FeatureVector;
}

function encodeOHLCV(candles: OHLCV[]): number[][] {
  return candles.map((candle) => [
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
  ]);
}

/**
 * Owns the internal-to-AI-service contract. Keeping this projection in one
 * place prevents feature-order and OHLCV-shape drift across callers.
 */
export function toBatchInferenceCandidate(
  candidate: InferenceCandidateContext,
): BatchInferenceCandidate {
  return {
    symbol: candidate.symbol,
    ohlcv: encodeOHLCV(candidate.candles),
    features: {
      ...candidate.features,
      ranker_features: candidate.features.rankerIncomplete
        ? null
        : toRankerFeatureArray(candidate.features),
    },
  };
}

export function toBatchInferenceCandidates(
  candidates: InferenceCandidateContext[],
): BatchInferenceCandidate[] {
  return candidates.map(toBatchInferenceCandidate);
}
