import axios from "axios";
import { logger } from "../lib/logger";
import { getMarketState } from "../market_data/market_state";
import { fetchOptionChainData } from "../market_data/option_chain";
import { getGlobalMacroState } from "./global_macro";
import { getFiiDiiDivergence } from "./divergence_engine";
import { computeOFI } from "./order_flow";
import { fetchFIIDIIData } from "../market_data/fii_dii";
import { buildSnapshot, computeMACD, type OHLCV } from "./technical";
import type { LayaDecision, LayaVerdict, LayaAction, LayaDecisionRequest } from "./laya_contract";
import type {
  System1Decision,
  System1Verdict,
  System1Action,
  System1DecisionRequest,
  System1Provider,
} from "./system1_contract";

export type {

  LayaDecision,
  LayaVerdict,
  LayaAction,
  LayaDecisionRequest,
  System1Decision,
  System1Verdict,
  System1Action,
  System1DecisionRequest,
  System1Provider,
};

export interface BatchInferenceCandidate {
  symbol: string;
  ohlcv: number[][];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  features: any;
}

export interface BatchResult {
  symbol: string;
  isFallback?: boolean;
  technicalRanking: {
    bullish_probability: number;
    confidence: number;
    detected_patterns: string[];
    source: string;
  };
  chronos: {
    median_forecast: number[];
    quantile_forecasts: Record<string, number[]>;
    trend: string;
    forecast_return_pct: number;
    source: string;
  };
  /** 0-100 news sentiment (Python's -1..1 is normalized at the parse boundary). */
  sentiment_score: number;
  world_sentiment_score?: number;
  composite_score: number;
  components?: Record<string, number>;
  /** Calibrated P(target1 before stop) from the learned ranker; null/undefined
   *  when the ranker is unavailable and the composite score should drive ranking. */
  win_probability?: number | null;
  /** False when the Python service hit a per-candidate exception and returned a
   *  neutral 50 placeholder rather than a real blended score. Such a candidate
   *  must not be treated as a genuine mid-strength setup. */
  scored?: boolean;
  /** Recommended P(win) gate + whether the learned ranker served this batch.
   *  Stamped onto every result from the batch-level response so the ranking
   *  gate has them without threading a second return value. */
  ranker_threshold?: number | null;
  ranker_loaded?: boolean;
  shap_values?: Record<string, number>;
  laya_decision?: LayaDecision;
  system1_decision?: System1Decision;
}

export interface BatchResponse {
  results: BatchResult[];
  processing_time_ms: number;
  ranker_threshold?: number | null;
  ranker_loaded?: boolean;
  laya_enabled?: boolean;
  system1_enabled?: boolean;
}

export interface HealthResponse {
  status: string;
  ai_mode: string;
  ranking_provider: string;
  uptime_seconds: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  models: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hardware: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  diagnostics: Record<string, any>;
}

function getAiServiceUrl(): string {
  return process.env.AI_SERVICE_URL || "http://localhost:8001";
}

function getAiServiceHeaders(): Record<string, string> {
  const token = process.env.AI_SERVICE_TOKEN?.trim();
  return token ? { "X-AI-Service-Token": token } : {};
}

// Lightweight Circuit Breaker (Resolves Finding 1B & 2A)
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold = 5;
  private readonly cooldownMs = 15_000;

  canRequest(): boolean {
    if (this.failures >= this.failureThreshold) {
      if (Date.now() - this.lastFailureTime > this.cooldownMs) {
        this.failures = Math.floor(this.failureThreshold / 2); // Half-open
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
  }
}

const aiCircuitBreaker = new CircuitBreaker();
const AI_HEALTH_CACHE_TTL_MS = 30_000;
// A degraded/unreachable result is usually a cold-start snapshot (Chronos takes
// a few seconds to load). Re-probe quickly so the dashboard self-heals fast
// instead of pinning "DEGRADED" for a full cache window.
const AI_HEALTH_DEGRADED_TTL_MS = 5_000;
const AI_HEALTH_STALE_OK_MS = 2 * 60_000;
// The /health endpoint returns a cached snapshot and is cheap, but on GPU hosts
// the first uncached refresh shells out to nvidia-smi (up to ~2s). Give it a
// generous, configurable budget so a slow probe never masquerades as "down".
const AI_HEALTH_TIMEOUT_MS = Number(process.env.AI_HEALTH_TIMEOUT_MS) || 5_000;
// Real inference latency is dominated by Chronos + the pattern engine. On CPU a
// single candidate is ~12s; on the target GPU it is far quicker but a cold call
// still blows past a 2s budget. Use a realistic, configurable base and let it
// scale with the batch size so large scans don't false-timeout mid-flight.
const AI_INFERENCE_TIMEOUT_MS = Number(process.env.AI_INFERENCE_TIMEOUT_MS) || 30_000;
const AI_INFERENCE_PER_CANDIDATE_MS = Number(process.env.AI_INFERENCE_PER_CANDIDATE_MS) || 500;
const AI_INFERENCE_TIMEOUT_CAP_MS = Number(process.env.AI_INFERENCE_TIMEOUT_CAP_MS) || 120_000;
let cachedAIHealth: { value: HealthResponse; checkedAt: number } | null = null;
let aiHealthInFlight: Promise<HealthResponse> | null = null;

export async function checkAIHealth(): Promise<HealthResponse> {
  const now = Date.now();
  if (cachedAIHealth) {
    const ttl = cachedAIHealth.value.status === "healthy" ? AI_HEALTH_CACHE_TTL_MS : AI_HEALTH_DEGRADED_TTL_MS;
    if (now - cachedAIHealth.checkedAt < ttl) {
      return cachedAIHealth.value;
    }
  }
  if (aiHealthInFlight) {
    return aiHealthInFlight;
  }

  const url = `${getAiServiceUrl()}/health`;
  aiHealthInFlight = (async () => {
    // The /health probe is deliberately decoupled from the inference circuit
    // breaker. The breaker trips on inference latency/errors, but /health is a
    // cheap cached snapshot — letting a tripped breaker short-circuit it made a
    // perfectly healthy service report "degraded" purely because inference was
    // slow. Probe the endpoint directly and let its own status speak for itself.
    const res = await axios.get(url, { timeout: AI_HEALTH_TIMEOUT_MS });
    const health = res.data as HealthResponse;
    const previousStatus = cachedAIHealth?.value.status;
    cachedAIHealth = { value: health, checkedAt: Date.now() };

    if (previousStatus && previousStatus !== health.status) {
      import("../ws/websocket_server").then(({ broadcast }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        broadcast({ event: "session_state_changed", data: {} } as any);
      }).catch((err) => {
        logger.error({ err }, "Failed to broadcast AI status change");
      });
    }
    return health;
  })();

  try {
    return await aiHealthInFlight;
  } catch (err) {
    if (
      cachedAIHealth?.value.status === "healthy" &&
      Date.now() - cachedAIHealth.checkedAt < AI_HEALTH_STALE_OK_MS
    ) {
      logger.debug({ err: (err as Error).message }, "FastAPI /health check failed; reusing recent healthy AI status");
      return cachedAIHealth.value;
    }

    logger.warn(
      { err: (err as Error).message, url, timeoutMs: AI_HEALTH_TIMEOUT_MS },
      "FastAPI /health check failed (AI service unreachable); reporting degraded and using Native Math Model fallback",
    );
    return {
      status: "degraded",
      ai_mode: "Native Math Model (Fallback)",
      ranking_provider: "Native Rankings",
      uptime_seconds: process.uptime(),
      models: {
        technical_engine: { loaded: false, healthy: false, fallback_active: true },
        chronos: { loaded: false, healthy: false, fallback_active: true },
        ranker: { loaded: false, healthy: false, fallback_active: true },
        sentiment: { loaded: false, healthy: false, fallback_active: true, fallback_mode: "keyword_or_neutral" },
        confluence: { loaded: false, healthy: false, fallback_active: true },
        rl_inference: { loaded: false, healthy: false, fallback_active: true },
          laya: { loaded: true, healthy: true, fallback_active: true, mode: "native_ts_laya" },
          system1: { loaded: true, healthy: true, fallback_active: true, mode: "native_ts_laya" },
      },
      hardware: { type: "Node.js Fallback" },
      diagnostics: { latency: "0ms", error: "FastAPI unreachable" }
    };
  } finally {
    aiHealthInFlight = null;
  }
}

export async function batchInference(
  candidates: BatchInferenceCandidate[]
): Promise<Map<string, BatchResult>> {
  const aiResults = new Map<string, BatchResult>();
  if (candidates.length === 0) return aiResults;

  if (aiCircuitBreaker.canRequest()) {
    try {
      const divergence = await getFiiDiiDivergence();
      const enrichedCandidates = candidates.map((c) => {
        // Explode OHLCV into target and covariates for the Chronos-Bolt-Small python backend
        const target = c.ohlcv.map((row) => row[3]); // Close price
        const past_covariates = c.ohlcv.map((row) => [row[0], row[1], row[2], row[4]]); // Open, High, Low, Volume
        
        return {
          ...c,
          target,
          past_covariates,
          features: {
            ...(c.features || {}),
            macro_divergence_penalty: divergence.penaltyOrBoost,
            ofi_ratio: computeOFI(c.symbol).ofiRatio
          }
        };
      });

      const url = `${getAiServiceUrl()}/inference/batch`;
      // Scale the timeout with the batch size. A flat 2s budget was the real
      // root cause of the "HEURISTIC FALLBACK" label: genuine inference (Chronos
      // + pattern engine) takes ~12s per candidate on CPU and still exceeds 2s
      // on a cold GPU call, so every batch timed out and reverted to the Native
      // Math Model with isFallback=true. The repeated timeouts also tripped the
      // circuit breaker, which then dragged /health into a false "degraded".
      const inferenceTimeoutMs = Math.min(
        AI_INFERENCE_TIMEOUT_CAP_MS,
        AI_INFERENCE_TIMEOUT_MS + enrichedCandidates.length * AI_INFERENCE_PER_CANDIDATE_MS,
      );
      logger.debug(
        { url, candidates: enrichedCandidates.length, timeoutMs: inferenceTimeoutMs },
        "Calling Python AI service for batch inference",
      );
      const response = await axios.post<BatchResponse>(url, { candidates: enrichedCandidates }, { headers: getAiServiceHeaders(), timeout: inferenceTimeoutMs });
      
      if (response.data && Array.isArray(response.data.results)) {
        aiCircuitBreaker.recordSuccess();
        for (const res of response.data.results) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((res as any).kronos && !res.technicalRanking) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            res.technicalRanking = (res as any).kronos;
          }
          // `isFallback` means the AI contribution is unusable and the signal
          // generator should revert to pure-technical confidence. The pattern
          // engine (source "engine") and sentiment always run when the Python
          // service responds, so a *synthetic Chronos* forecast alone is NOT a
          // fallback — it is a real, if simpler, momentum/mean-reversion estimate
          // carrying only 10% weight. Treat it as fallback only when the pattern
          // engine itself failed (its bullish_probability is the primary driver).
          // Chronos degradation is still visible to consumers via `chronos.source`.
          // Treat as fallback when the pattern engine errored OR when Python
          // explicitly flagged the candidate as unscored (per-candidate exception
          // → neutral 50 placeholder). Either way the AI contribution is unusable
          // and the signal generator must revert to pure-technical confidence.
          const isFallback = res.technicalRanking?.source === "error" || (res as BatchResult).scored === false;
          // Python emits sentiment_score on a -1.0..1.0 scale; normalize to the
          // 0-100 scale consumers expect (matching the native fallback below),
          // with a missing score mapping to neutral 50.
          const sentiment_score = Math.max(0, Math.min(100, ((res.sentiment_score ?? 0) + 1) * 50));
          // Stamp the batch-level ranker metadata onto each result so the signal
          // generator can apply the learned-probability gate per candidate without
          // threading a separate return value.
          aiResults.set(res.symbol, {
            ...res,
            sentiment_score,
            isFallback,
            ranker_loaded: response.data.ranker_loaded ?? false,
            ranker_threshold: response.data.ranker_threshold ?? null,
          });
        }
        return aiResults;
      }
    } catch (err) {
      aiCircuitBreaker.recordFailure();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isTimeout = (err as any)?.code === "ECONNABORTED";
      logger.warn(
        {
          err: (err as Error).message,
          reason: isTimeout ? "inference_timeout" : "unreachable_or_error",
          candidates: candidates.length,
        },
        "Python AI batch inference failed; falling back to Native Math Model (results flagged isFallback=true)",
      );
    }
  } else {
    logger.debug("AI Circuit Breaker open, skipping FastAPI call and using Native Math Model directly.");
  }

  // FALLBACK: Native Math Model (Advanced Stochastic Engine)
  const [fiiDii, optionChain] = await Promise.all([
    fetchFIIDIIData(),
    fetchOptionChainData(),
  ]);
  const macroState = getGlobalMacroState();
  const marketState = getMarketState();
    const defaultEngine = "laya" as const;

  for (const c of candidates) {
    if (c.ohlcv.length < 55) continue; // We need at least 55 for a good technical snapshot

    // Per-candidate isolation. This loop sits OUTSIDE the microservice try/catch
    // above, so a single malformed row (`row[0]` on a null entry throws a
    // TypeError) or a non-numeric field (Number(undefined) -> NaN) previously
    // rejected the whole batch and discarded every other candidate's results.
    let candles: OHLCV[];
    try {
      candles = c.ohlcv.map((row, index): OHLCV => ({
        timestamp: String(index),
        open: Number(row?.[0]),
        high: Number(row?.[1]),
        low: Number(row?.[2]),
        close: Number(row?.[3]),
        volume: Number(row?.[4] ?? 0),
      }));
    } catch (err) {
      logger.warn({ err: (err as Error).message, symbol: c.symbol }, "Skipping candidate with malformed ohlcv in native fallback");
      continue;
    }

    // Reject non-finite series outright: a NaN close propagates into lastClose,
    // drift and forecast_return_pct, and every comparison against NaN is false,
    // so the candidate would silently score off garbage.
    if (candles.some((x) => !Number.isFinite(x.open) || !Number.isFinite(x.high) || !Number.isFinite(x.low) || !Number.isFinite(x.close))) {
      logger.warn({ symbol: c.symbol }, "Skipping candidate with non-finite ohlcv in native fallback");
      continue;
    }

    const snap = buildSnapshot(candles);
    if (!snap) continue;

    // Remaining per-candidate maths is wrapped so a throw in indicator maths or
    // snapshot construction cannot reject the whole batchInference() promise.
    try {
    const returns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1].close;
      const curr = candles[i].close;
      if (prev > 0) returns.push((curr - prev) / prev);
    }
    if (returns.length === 0) continue;

    // 1. EWMA Volatility calculation (Lambda = 0.94 is standard for daily returns)
    let ewmaVar = returns[0] * returns[0];
    const lambda = 0.94;
    for (let i = 1; i < returns.length; i++) {
      ewmaVar = lambda * ewmaVar + (1 - lambda) * (returns[i] * returns[i]);
    }
    const stdDev = Math.sqrt(ewmaVar);

    const lastClose = candles[candles.length - 1].close;
    const HORIZON = 90; // 90 days forecast
    const detected_patterns = [];

    // 2. Indicator-Driven Drift
    // Base drift is slightly positive
    let drift = 0.0001; 

    // Adjust drift based on Trend and ADX (Momentum strength)
    if (snap.trend === "UP") {
      const adxMultiplier = Math.min(snap.adx14 / 25, 2.0); // ADX > 25 adds strong drift
      drift += 0.0005 * adxMultiplier;
      detected_patterns.push("Trend Alignment: Bullish");
    } else if (snap.trend === "DOWN") {
      const adxMultiplier = Math.min(snap.adx14 / 25, 2.0);
      drift -= 0.0005 * adxMultiplier;
      detected_patterns.push("Trend Alignment: Bearish");
    }

    // Adjust drift based on distance from EMA20 (Rubber band effect)
    if (snap.distFromEma20Pct > 10) {
      drift -= 0.001; // Pulled too far up
    } else if (snap.distFromEma20Pct < -10) {
      drift += 0.001; // Pulled too far down
    }

    // Smart Money VWAP & Volume Profile Adjustment
    if (snap.vwap && snap.vpvrPOC) {
      const distFromVwapPct = ((lastClose - snap.vwap) / snap.vwap) * 100;
      const distFromPocPct = ((lastClose - snap.vpvrPOC) / snap.vpvrPOC) * 100;
      
      // If we are slightly above VWAP and POC, institutions are defending this level.
      if (distFromVwapPct > 0 && distFromPocPct > 0 && distFromPocPct < 5) {
        drift += 0.0008; 
        detected_patterns.push("Institutional Support: Above POC & VWAP");
      } 
      // If we are far below POC, we are in a low liquidity void, expect mean reversion towards POC
      else if (distFromPocPct < -3) {
        drift += 0.0005;
        detected_patterns.push("Liquidity Void: Magnet to POC");
      }
      // If price is crashing through VWAP and POC downwards
      else if (distFromVwapPct < 0 && distFromPocPct < 0) {
        drift -= 0.0008;
        detected_patterns.push("Institutional Distribution: Below POC & VWAP");
      }
    }

    // 3. Mean Reversion (RSI Penalty)
    if (snap.rsi14 > 75) {
      drift -= 0.0015; // Heavy penalty for extreme overbought
      detected_patterns.push("Overbought: Mean Reversion Expected");
    } else if (snap.rsi14 < 30) {
      drift += 0.0015; // Heavy boost for extreme oversold
      detected_patterns.push("Oversold: Bounce Expected");
    }

    // 3.5 MACD Histogram Slope Confluence
    const closes = candles.map((c) => c.close);
    const macdResults = computeMACD(closes);
    if (macdResults.length >= 2) {
      const lastMacd = macdResults[macdResults.length - 1];
      const prevMacd = macdResults[macdResults.length - 2];
      if (lastMacd && prevMacd && lastMacd.histogram > prevMacd.histogram && lastMacd.histogram > 0) {
        drift += 0.0006;
        detected_patterns.push("MACD Momentum Confluence: Positive Slope");
      } else if (lastMacd && prevMacd && lastMacd.histogram < prevMacd.histogram && lastMacd.histogram < 0) {
        drift -= 0.0006;
        detected_patterns.push("MACD Momentum Confluence: Negative Slope");
      }
    }

    // Prevent impossible drifts
    drift = Math.max(-0.005, Math.min(0.005, drift));

    const median_forecast: number[] = [];
    const q10: number[] = [];
    const q25: number[] = [];
    const q75: number[] = [];
    const q90: number[] = [];

    for (let t = 1; t <= HORIZON; t++) {
      const driftTerm = (drift - 0.5 * ewmaVar) * t;
      const volTerm = stdDev * Math.sqrt(t);

      median_forecast.push(lastClose * Math.exp(driftTerm));
      q10.push(lastClose * Math.exp(driftTerm - 1.28 * volTerm));
      q25.push(lastClose * Math.exp(driftTerm - 0.67 * volTerm));
      q75.push(lastClose * Math.exp(driftTerm + 0.67 * volTerm));
      q90.push(lastClose * Math.exp(driftTerm + 1.28 * volTerm));
    }

    const forecast_return_pct = ((median_forecast[HORIZON - 1] - lastClose) / lastClose) * 100;
    const trend = forecast_return_pct > 2 ? "bullish" : forecast_return_pct < -2 ? "bearish" : "neutral";

    if (stdDev > 0.025) detected_patterns.push("High Recent Volatility (EWMA)");
    if (snap.volumeAnomaly) detected_patterns.push("Volume Anomaly Detected");

    // Baseline probability using Logistic function on the Sharpe-like ratio
    const x = drift / (stdDev * Math.sqrt(1) + 1e-9);
    let prob = 1 / (1 + Math.exp(-x * 2.0)); 

    // 4. Volume-Weighted Confidence
    let confidence = Math.max(0.1, 1 - stdDev * 12);
    if (snap.volumeRatio > 1.5) {
      confidence = Math.min(0.99, confidence * 1.2); // 20% boost to confidence on high volume
    } else if (snap.volumeRatio < 0.7) {
      confidence *= 0.8; // Penalty for low volume
    }

    // Phase 5: Macro-Coupled AI Penalty
    if (macroState.eventRiskActive) {
      prob *= 0.90; // 10% penalty
      confidence *= 0.85;
      detected_patterns.push("Macro Risk Penalty Applied");
    }

    // Phase 6: Indian Market Institutional & Sentiment Edge
    if (fiiDii) {
      if (fiiDii.fiiNetInr < -2000) {
        prob *= 0.85; 
        detected_patterns.push("Heavy FII Selling Penalty");
      } else if (fiiDii.fiiNetInr > 2000) {
        prob *= 1.15; 
        detected_patterns.push("FII Buying Boost");
      }
    }

    if (optionChain) {
      if (optionChain.pcr < 0.7) {
        prob *= 0.90; 
        detected_patterns.push("Bearish PCR Penalty");
      } else if (optionChain.pcr > 1.2) {
        prob *= 1.10; 
        detected_patterns.push("Bullish PCR Boost");
      }
    }

    prob = Math.max(0, Math.min(0.99, prob)); 
    const composite_score = Math.max(0, Math.min(100, Math.round(prob * 100)));

    const sys1Req: System1DecisionRequest = {
      symbol: c.symbol,
      direction: c.features?.direction ?? "BUY",
      setup_type: c.features?.setup_type ?? c.features?.setupType ?? "UNKNOWN",
      technical_score: composite_score,
      chronos_trend: trend,
      risk_reward_ratio: c.features?.risk_reward_ratio ?? c.features?.riskReward ?? c.features?.riskRewardScore ?? 1.5,
      india_vix: c.features?.india_vix ?? c.features?.vix ?? marketState.indiaVix ?? 15.0,
      order_flow_imbalance_ratio: c.features?.order_flow_imbalance_ratio ?? c.features?.ofi_ratio ?? c.features?.bidAskImbalance ?? computeOFI(c.symbol).ofiRatio,
      fii_dii_net: c.features?.fii_dii_net ?? c.features?.fiiNet ?? c.features?.fiiDiiNetFlowLag ?? fiiDii?.fiiNetInr ?? 0.0,
      market_regime: c.features?.market_regime ?? c.features?.regime ?? "UNKNOWN",
      win_probability: null,
    };
    const nativeDecision = computeNativeSystem1Decision(sys1Req, defaultEngine);
    const nativeLaya: LayaDecision = defaultEngine === "laya"
      ? nativeDecision
      : computeNativeLayaDecision(sys1Req);

    aiResults.set(c.symbol, {
      symbol: c.symbol,
      isFallback: true,
      technicalRanking: {
        bullish_probability: prob,
        confidence: confidence,
        detected_patterns,
        source: "Advanced Stochastic Engine",
      },
      chronos: {
        median_forecast,
        quantile_forecasts: { q10, q25, q75, q90 },
        trend,
        forecast_return_pct,
        source: "Indicator-Driven TS",
      },
      // The native fallback has no news data — report neutral 50, never a
      // price-derived number masquerading as news sentiment.
      sentiment_score: 50,
      composite_score,
      laya_decision: nativeLaya,
      system1_decision: nativeDecision,
    });
    } catch (err) {
      logger.warn({ err: (err as Error).message, symbol: c.symbol }, "Native fallback failed for candidate; continuing batch");
    }
  }

  return aiResults;
}

const aiCache = new Map<string, { result: BatchResult, ts: number }>();
const inFlightInference = new Map<string, Promise<BatchResult | null>>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
// Hard cap on cached forecasts. The TTL was only ever checked on READ and
// nothing was ever deleted, so every symbol ever inferred stayed resident for
// the life of the process — each entry carrying ~450 forecast numbers
// (median_forecast[90] plus 4 quantile series). Reachable across the full
// scan universe, that is a monotonic heap leak in an all-session process.
const AI_CACHE_MAX = Number(process.env["AI_CACHE_MAX"] ?? "5000");

function pruneAiCache() {
  if (aiCache.size <= AI_CACHE_MAX) return;
  // Oldest-timestamp first.
  const overflow = aiCache.size - AI_CACHE_MAX;
  let removed = 0;
  for (const [key] of [...aiCache.entries()].sort((a, b) => a[1].ts - b[1].ts)) {
    if (removed >= overflow) break;
    aiCache.delete(key);
    removed += 1;
  }
}

export async function inferSymbolForecast(
  symbol: string,
  candles: OHLCV[],
  features: Record<string, unknown> = {},
): Promise<BatchResult | null> {
  const cached = aiCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.result;
  }

  let pending = inFlightInference.get(symbol);
  if (pending) {
    return pending;
  }

  pending = (async () => {
    try {
      const ohlcv = candles.map((c) => [c.open, c.high, c.low, c.close, c.volume]);
      const results = await batchInference([{ symbol, ohlcv, features }]);
      const result = results.get(symbol) ?? null;
      if (result) {
        aiCache.set(symbol, { result, ts: Date.now() });
        pruneAiCache();
      }
      return result;
    } finally {
      inFlightInference.delete(symbol);
    }
  })();

  inFlightInference.set(symbol, pending);
  return pending;
}

export interface RLPrediction {
  action: string;
  confidence: number;
  score_adjustment: number;
}

export async function getRLPrediction(symbol: string, candles: OHLCV[]): Promise<RLPrediction | null> {
  if (!process.env.AI_SERVICE_URL) {
    return null;
  }
  try {
    const ohlcv = candles.map((c) => [0, c.open, c.high, c.low, c.close, c.volume]);
    
    // Fetch Macro Data
    const marketState = getMarketState();
    const vix = marketState.indiaVix ?? 15.0;
    const fiiNet = marketState.fiiNetInr ?? 0.0;
    
    // Option chain is heavily cached internally
    const optionChain = await fetchOptionChainData();
    const pcr = optionChain?.pcr ?? 1.0;

    const response = await axios.post(
      `${getAiServiceUrl()}/api/v1/predict_rl`,
      { symbol, ohlcv, vix, pcr, fii_dii_net: fiiNet },
      { headers: { "Content-Type": "application/json", ...getAiServiceHeaders() }, timeout: 5000 }
    );
    return response.data as RLPrediction;
  } catch (err) {
    logger.warn(`Failed to get RL prediction for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

export async function triggerRLTraining(): Promise<boolean> {
  if (!process.env.AI_SERVICE_URL) return false;
  try {
    const response = await axios.post(
      `${getAiServiceUrl()}/api/v1/rl_train`,
      {},
      { headers: getAiServiceHeaders(), timeout: 5000 }
    );
    return response.status === 200;
  } catch (err) {
    logger.error({ err }, "Failed to trigger RL training");
    return false;
  }
}

export async function triggerRankerTraining(): Promise<boolean> {
  if (!process.env.AI_SERVICE_URL) return false;
  try {
    const response = await axios.post(
      `${getAiServiceUrl()}/api/v1/ranker_train`,
      {},
      { headers: getAiServiceHeaders(), timeout: 5000 }
    );
    return response.status === 200;
  } catch (err) {
    logger.error({ err }, "Failed to trigger ranker training");
    return false;
  }
}

export interface RLStatusResponse {
  status?: string;
  episode?: number;
  reward?: number;
  [key: string]: unknown;
}
export async function getConfluenceScore(
  regime: string,
  features: Record<string, number>
): Promise<{ score: number, fallback: boolean }> {
  if (!process.env.AI_SERVICE_URL) return { score: 50.0, fallback: true };
  try {
    const url = `${getAiServiceUrl()}/confluence_score`;
    const response = await axios.post(url, { regime, features }, { headers: getAiServiceHeaders(), timeout: 3000 });
    if (response.status === 200 && response.data) {
      return {
        score: response.data.score,
        fallback: response.data.fallback || false
      };
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Failed to get confluence score");
  }
  return { score: 50.0, fallback: true };
}
export async function triggerConfluenceTraining(): Promise<boolean> {
  if (!process.env.AI_SERVICE_URL) return false;
  try {
    const response = await axios.post(
      `${getAiServiceUrl()}/api/v1/confluence_train`,
      {},
      { headers: getAiServiceHeaders(), timeout: 5000 }
    );
    return response.status === 200;
  } catch (err) {
    logger.error({ err }, "Failed to trigger confluence training");
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// System-1 (LAYA) Service Integrations & Native Fallbacks
// ─────────────────────────────────────────────────────────────────────────────

export function computeNativeSystem1Decision(
  req: System1DecisionRequest,
  provider: "laya" = "laya",
): System1Decision {
  const safeNum = (v: unknown, fallback: number): number => {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  const safeStr = (v: unknown, fallback: string): string => {
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;
  };

  const direction = safeStr(req.direction, "BUY").toUpperCase();
  const setupType = safeStr(req.setup_type, "PULLBACK").toUpperCase();
  const techScore = safeNum(req.technical_score, 50.0);
  const rr = safeNum(req.risk_reward_ratio, 1.5);
  const ofi = safeNum(req.order_flow_imbalance_ratio, 0.0);
  const fiiNet = safeNum(req.fii_dii_net, 0.0);
  const vix = safeNum(req.india_vix, 15.0);
  const regime = safeStr(req.market_regime, "UNKNOWN").toUpperCase();
  const chronosTrend = safeStr(req.chronos_trend, "neutral").toLowerCase();
  const sentimentScore = safeNum(req.sentiment_score, 0.0);
  const winProb = typeof req.win_probability === "number" && Number.isFinite(req.win_probability)
    ? req.win_probability
    : null;

  const gateReasons: string[] = [];

  let regimeAlignment = 0.0;
  if (regime.includes("BULL")) {
    regimeAlignment = direction === "BUY" ? 0.8 : -0.8;
  } else if (regime.includes("BEAR")) {
    regimeAlignment = direction === "BUY" ? -0.8 : 0.8;
  } else if (regime.includes("SIDEWAYS") || regime.includes("RANGE")) {
    regimeAlignment = (setupType.includes("PULLBACK") || setupType.includes("REVERSION")) ? 0.2 : -0.1;
  } else if (regime.includes("VOLATILE")) {
    regimeAlignment = -0.5;
  }

  // Hard risk checks
  let hardReject = false;

  if (vix > 25.0) {
    hardReject = true;
    gateReasons.push("HIGH_VOLATILITY_VIX_SPIKE");
  } else if (vix > 20.0 && regimeAlignment < 0) {
    hardReject = true;
    gateReasons.push("ELEVATED_VIX_COUNTER_REGIME");
  }

  if (rr < 1.2) {
    hardReject = true;
    gateReasons.push(`UNFAVORABLE_RISK_REWARD_${rr.toFixed(2)}`);
  }

  if (direction === "BUY" && fiiNet < -2500.0) {
    hardReject = true;
    gateReasons.push("HEAVY_INSTITUTIONAL_SELLING");
  } else if (direction === "SELL" && fiiNet > 2500.0) {
    hardReject = true;
    gateReasons.push("HEAVY_INSTITUTIONAL_BUYING");
  }

  if (winProb !== null && winProb < 0.45) {
    hardReject = true;
    gateReasons.push(`LOW_RANKER_WIN_PROB_${winProb.toFixed(2)}`);
  }

  if ((direction === "BUY" && ofi < -0.35) || (direction === "SELL" && ofi > 0.35)) {
    hardReject = true;
    gateReasons.push("SEVERE_ORDER_FLOW_CONTRADICTION");
  }

  // RLCD-Calibrated Noul Bernoulli Probabilities
  const ofiConfluence = ((direction === "BUY" && ofi > 0.1) || (direction === "SELL" && ofi < -0.1))
    ? 0.5
    : (((direction === "BUY" && ofi < -0.1) || (direction === "SELL" && ofi > 0.1)) ? -0.5 : 0.0);

  const zExec = 0.5 + ofiConfluence + 0.4 * regimeAlignment - 0.05 * Math.max(0, vix - 16.0);

  const zHunt = -1.2 + 0.1 * Math.max(0, vix - 15.0) - (rr >= 2.0 ? 0.3 : -0.3)
    + (setupType.includes("BREAKOUT") && (regime.includes("SIDEWAYS") || regime.includes("VOLATILE")) ? 0.5 : 0);

  const zShift = -1.5 + (regimeAlignment < 0 ? 0.8 : 0) + 0.08 * Math.max(0, vix - 18.0)
    + ((direction === "BUY" && chronosTrend === "bearish") || (direction === "SELL" && chronosTrend === "bullish") ? 0.5 : 0);

  const sigmoid = (z: number): number => {
    return Math.round((1.0 / (1.0 + Math.exp(-Math.max(-10.0, Math.min(10.0, z))))) * 10000) / 10000;
  };

  const pExec = sigmoid(zExec);
  const pHunt = sigmoid(zHunt);
  const pShift = sigmoid(zShift);

  // Model identity must be honest. This is a hand-written deterministic
  // heuristic, NOT the ConvAI Innovations LAYA model, so stamping it with the
  // real `convaiinnovations/laya` model id attributes heuristic output to a
  // calibrated neural model in every downstream metric keyed on `model_id`.
  const modelId = "native_ts_deterministic_surrogate";


  if (hardReject) {
    return {
      verdict: "REJECT",
      action: "CANCEL",
      confidence: 0.88,
      opportunity_score: 15.0,
      gate_reasons: gateReasons,
      regime_alignment: Math.round(regimeAlignment * 100) / 100,
      p_execution_success: Math.min(0.20, Math.round(pExec * 0.3 * 10000) / 10000),
      p_stop_hunt_risk: Math.max(0.75, pHunt),
      p_adverse_regime_shift: Math.max(0.70, pShift),
      position_size_multiplier: 0.0,
      provider,
      model_id: modelId,
      source: "native_ts_laya",
    };
  }

  let baseOpp = techScore * 0.45 + (rr / 3.0) * 20.0 + (regimeAlignment + 1.0) * 15.0;
  if ((direction === "BUY" && ofi > 0.2) || (direction === "SELL" && ofi < -0.2)) {
    baseOpp += 10.0;
    gateReasons.push("POSITIVE_ORDER_FLOW_CONFLUENCE");
  }
  if ((direction === "BUY" && chronosTrend === "bullish") || (direction === "SELL" && chronosTrend === "bearish")) {
    baseOpp += 10.0;
    gateReasons.push("CHRONOS_DIRECTIONAL_ALIGNMENT");
  }
  if ((sentimentScore > 0.2 && direction === "BUY") || (sentimentScore < -0.2 && direction === "SELL")) {
    baseOpp += 5.0;
  }
  if (winProb !== null && winProb >= 0.65) {
    baseOpp += 5.0;
    gateReasons.push("RANKER_CONVICTION_ALIGNMENT");
  }

  const oppScore = Math.max(0, Math.min(100, Math.round(baseOpp * 10) / 10));
  const isPullback = setupType.includes("PULLBACK") || setupType.includes("REVERSION");

  if (oppScore >= 70.0 && regimeAlignment >= 0.0) {
    const action: System1Action = (pHunt > 0.35 && !isPullback) ? "LIMIT_PULLBACK" : "EXECUTE_IMMEDIATELY";
    if (action === "LIMIT_PULLBACK") {
      gateReasons.push("PULLBACK_ENTRY_PREFERRED");
    } else {
      gateReasons.push("STRONG_SYSTEM_ONE_CONVICTION");
    }
    let confidence = Math.min(0.95, 0.65 + (oppScore - 70.0) * 0.01);
    const ofiAligned = (direction === "BUY" && ofi > 0.1) || (direction === "SELL" && ofi < -0.1);
    // Size from calibrated probabilities, mirroring the Python tiers: scale up
    // only on clean execution odds, and scale *down* when stop-hunt or
    // regime-collapse risk is elevated rather than ignoring it.
    let sizeMultiplier: number;
    if (confidence >= 0.80 && pExec >= 0.70 && pHunt <= 0.20 && pShift <= 0.20 && ofiAligned) {
      sizeMultiplier = 1.25;
      gateReasons.push("POSITION_SIZE_SCALED_UP_1.25X");
    } else if (pHunt > 0.35 || pShift > 0.30 || pExec < 0.55) {
      sizeMultiplier = 0.85;
      gateReasons.push("POSITION_SIZE_SCALED_DOWN_0.85X");
    } else {
      sizeMultiplier = 1.0;
    }

    const source = "native_ts_laya";

    return {
      verdict: "APPROVE",
      action,
      confidence: Math.round(confidence * 100) / 100,
      opportunity_score: oppScore,
      gate_reasons: gateReasons,
      regime_alignment: Math.round(regimeAlignment * 100) / 100,
      p_execution_success: pExec,
      p_stop_hunt_risk: pHunt,
      p_adverse_regime_shift: pShift,
      position_size_multiplier: sizeMultiplier,
      provider,
      model_id: modelId,
      source,
    };
  } else if (oppScore >= 50.0) {
    gateReasons.push("MODERATE_OPPORTUNITY_REQUIRE_CONFIRMATION");
    const source = "native_ts_laya";
    return {
      verdict: "CAUTION",
      action: rr >= 1.5 ? "LIMIT_PULLBACK" : "CONFIRMED_ENTRY",
      confidence: 0.60,
      opportunity_score: oppScore,
      gate_reasons: gateReasons,
      regime_alignment: Math.round(regimeAlignment * 100) / 100,
      p_execution_success: pExec,
      p_stop_hunt_risk: pHunt,
      p_adverse_regime_shift: pShift,
      position_size_multiplier: 0.65,
      provider,
      model_id: modelId,
      source,
    };
  } else {
    gateReasons.push("LOW_OPPORTUNITY_SCORE");
    const source = "native_ts_laya";
    return {
      verdict: "REJECT",
      action: "CANCEL",
      confidence: 0.75,
      opportunity_score: oppScore,
      gate_reasons: gateReasons,
      regime_alignment: Math.round(regimeAlignment * 100) / 100,
      p_execution_success: pExec,
      p_stop_hunt_risk: pHunt,
      p_adverse_regime_shift: pShift,
      position_size_multiplier: 0.0,
      provider,
      model_id: modelId,
      source,
    };
  }
}

export function computeNativeLayaDecision(
  req: System1DecisionRequest,
): LayaDecision {
  return computeNativeSystem1Decision(req, "laya");
}

export async function evaluateLayaDecision(
  req: System1DecisionRequest,
): Promise<LayaDecision> {
  const url = `${getAiServiceUrl()}/inference/laya`;
  try {
    const res = await axios.post<LayaDecision>(url, req, {
      headers: getAiServiceHeaders(),
      timeout: 3000,
    });
    if (res.status === 200 && res.data) {
      return res.data;
    }
  } catch (err) {
    logger.debug(`LAYA inference error: ${(err as Error).message}; using native fallback`);
  }
  return computeNativeLayaDecision(req);
}

export async function evaluateSystem1Decision(
  req: System1DecisionRequest,
  _preferredEngine?: "auto",
): Promise<System1Decision> {
    const defaultEngine = "laya" as const;
  const targetEngine = defaultEngine;
  const url = `${getAiServiceUrl()}/inference/system1`;
  try {
    const payload = { ...req, preferred_engine: targetEngine };
    const res = await axios.post<System1Decision>(url, payload, {
      headers: getAiServiceHeaders(),
      timeout: 3000,
    });
    if (res.status === 200 && res.data) {
      return res.data;
    }
  } catch (err) {
    logger.debug(`System-1 inference error: ${(err as Error).message}; using native fallback`);
  }
  return computeNativeSystem1Decision(req, targetEngine);
}
