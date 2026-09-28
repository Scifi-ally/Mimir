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
 * Resolve risk-reward as a true R multiple.
 *
 * `FeatureVector.riskRewardScore` is a NORMALIZED 0-100 score where 3.0 maps to
 * 100 (see `computeRiskRewardScore` in feature_engine.ts), so it must never be
 * forwarded as an R multiple. Returns null when nothing usable is available, so
 * the caller applies its documented neutral default.
 */
function resolveRiskRewardMultiple(candidate: InferenceCandidateContext): number | null {
  const explicit = candidate.riskReward;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  // De-normalize: score 100 -> 3.0 R, score 33 -> ~0.99 R.
  const score = candidate.features?.riskRewardScore;
  if (typeof score === "number" && Number.isFinite(score) && score > 0 && score <= 100) {
    return (score / 100) * 3.0;
  }
  return null;
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
      // Must be a true R multiple (e.g. 2.0).
      //
      // `features.riskRewardScore` is NORMALIZED to 0-100 where 3.0 == 100
      // (feature_engine.ts `computeRiskRewardScore`). Falling back to it here
      // passed a 0-100 score as the R multiple, so a setup whose real R:R was
      // 0.3 reported `rr = 10`: the Python `rr < 1.2` hard gate passed, the
      // opportunity bonus added (10/3)*20 = 66.7 points, and the worst setup
      // possible was scored 100 / APPROVE / 1.25x. De-normalize instead, and
      // never emit a non-finite R multiple.
      risk_reward_ratio: resolveRiskRewardMultiple(candidate) ?? 1.5,
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
