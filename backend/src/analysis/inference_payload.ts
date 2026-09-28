import type { BatchInferenceCandidate } from "./ai_client";
import { toRankerFeatureArray } from "./ranker_contract";
import type { FeatureVector } from "./feature_engine";
import type { OHLCV } from "./technical";

export interface InferenceCandidateContext {
  symbol: string;
  candles: OHLCV[];
  features: FeatureVector;
  direction?: string;
  setupType?: string;
  entryPrice?: number;
  stopLoss?: number;
  target1?: number;
  riskReward?: number;
  marketRegime?: string;
  indiaVix?: number;
  ofiRatio?: number;
  fiiNet?: number;
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
      direction: candidate.direction ?? "BUY",
      setup_type: candidate.setupType ?? "UNKNOWN",
      entry_price: candidate.entryPrice ?? 0,
      stop_loss: candidate.stopLoss ?? 0,
      target1: candidate.target1 ?? 0,
      risk_reward_ratio: candidate.riskReward ?? candidate.features.riskRewardScore ?? 1.5,
      regime: candidate.marketRegime ?? "UNKNOWN",
      market_regime: candidate.marketRegime ?? "UNKNOWN",
      vix: candidate.indiaVix ?? 15.0,
      india_vix: candidate.indiaVix ?? 15.0,
      ofi_ratio: candidate.ofiRatio ?? candidate.features.bidAskImbalance ?? 0.0,
      fii_dii_net: candidate.fiiNet ?? candidate.features.fiiDiiNetFlowLag ?? 0.0,
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
