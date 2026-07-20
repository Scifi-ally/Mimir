import axios from "axios";
import { logger } from "../lib/logger";
import { getMarketState } from "../market_data/market_state";
import { fetchOptionChainData } from "../market_data/option_chain";
import { getGlobalMacroState } from "./global_macro";
import { getFiiDiiDivergence } from "./divergence_engine";
import { computeOFI } from "./order_flow";
import { fetchFIIDIIData } from "../market_data/fii_dii";
import { buildSnapshot, computeMACD, type OHLCV } from "./technical";

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
}

export interface BatchResponse {
  results: BatchResult[];
  processing_time_ms: number;
  ranker_threshold?: number | null;
  ranker_loaded?: boolean;
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
        technicalRanking: { loaded: false, healthy: false },
        chronos: { loaded: false, healthy: false }
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
      const enrichedCandidates = candidates.map((c) => ({
        ...c,
        features: {
          ...(c.features || {}),
          macro_divergence_penalty: divergence.penaltyOrBoost,
          ofi_ratio: computeOFI(c.symbol).ofiRatio
        }
      }));

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
      const response = await axios.post<BatchResponse>(url, { candidates: enrichedCandidates }, { timeout: inferenceTimeoutMs });
      
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
  for (const c of candidates) {
    if (c.ohlcv.length < 55) continue; // We need at least 55 for a good technical snapshot

    const candles = c.ohlcv.map(([open, high, low, close, volume], index): OHLCV => ({
      timestamp: String(index),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume ?? 0),
    }));

    const snap = buildSnapshot(candles);
    if (!snap) continue;

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
    const macroState = getGlobalMacroState();
    if (macroState.eventRiskActive) {
      prob *= 0.90; // 10% penalty
      confidence *= 0.85;
      detected_patterns.push("Macro Risk Penalty Applied");
    }

    // Phase 6: Indian Market Institutional & Sentiment Edge
    const fiiDii = await fetchFIIDIIData();
    const optionChain = await fetchOptionChainData();
    
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
    });
  }

  return aiResults;
}

const aiCache = new Map<string, { result: BatchResult, ts: number }>();
const inFlightInference = new Map<string, Promise<BatchResult | null>>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

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
      { headers: { "Content-Type": "application/json" }, timeout: 5000 }
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
      { timeout: 5000 }
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
      { timeout: 5000 }
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

export async function getRLStatus(): Promise<RLStatusResponse | null> {
  if (!process.env.AI_SERVICE_URL) return null;
  try {
    const response = await axios.get(
      `${getAiServiceUrl()}/api/v1/rl_status`,
      { timeout: 5000 }
    );
    return response.data;
  } catch (err) {
    logger.error({ err }, "Failed to get RL status");
    return null;
  }
}
