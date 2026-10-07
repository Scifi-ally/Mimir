import axios from "axios";
import { logger } from "../lib/logger";
import { fetchOptionChainData } from "../market_data/option_chain";
import { getFiiDiiDivergence } from "./divergence_engine";
import { computeOFI } from "./order_flow";
import { fetchFIIDIIData } from "../market_data/fii_dii";
import { getMarketFeedSnapshot } from "../market_data/market_feed";
import type { OHLCV } from "./technical";
import { inferenceSentiment } from "./inference_sentiment";
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
    forecast_return_pct: number | null;
    source: string;
  };
  /** 0-100 news sentiment (Python's -1..1 is normalized at the parse boundary). */
  sentiment_score: number | null;
  world_sentiment_score?: number | null;
  sentiment_evidence?: Record<string, unknown>;
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
          // generator should revert to pure-technical confidence. Chronos can
          // explicitly abstain when its model or required inputs are unavailable;
          // that advisory forecast must not be presented as verified evidence.
          // Treat as fallback when the pattern engine errored OR when Python
          // explicitly flagged the candidate as unscored (per-candidate exception
          // → neutral 50 placeholder). Either way the AI contribution is unusable
          // and the signal generator must revert to pure-technical confidence.
          if (res.technicalRanking?.source === "error" || res.scored === false) continue;
          const isFallback = false;
          // Python emits sentiment_score on a -1.0..1.0 scale; normalize to the
          // 0-100 scale consumers expect. Missing source evidence stays unknown.
          const measuredSentiment = inferenceSentiment(res.sentiment_score, res.sentiment_evidence?.symbol);
          const sentiment_score = measuredSentiment == null ? null : (measuredSentiment + 1) * 50;
          // Stamp the batch-level ranker metadata onto each result so the signal
          // generator can apply the learned-probability gate per candidate without
          // threading a separate return value.
          aiResults.set(res.symbol, {
            ...res,
            sentiment_score,
            world_sentiment_score: inferenceSentiment(res.world_sentiment_score, res.sentiment_evidence?.world),
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
        "Python AI batch inference unavailable; no synthetic model results published",
      );
    }
  } else {
    logger.debug("AI Circuit Breaker open; model results unavailable.");
  }

  // An unavailable model cannot supply a forecast, news score, or probability.
  // Real technical snapshots remain available through the scanner.
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
    
    // Missing macro sources must not be represented by plausible neutral
    // constants, which the model would consume as genuine observations.
    const feed = getMarketFeedSnapshot();
    const feedAt = feed.fetchedAt ? Date.parse(feed.fetchedAt) : NaN;
    const feedAgeMs = Date.now() - feedAt;
    const vix = feed.vixLtp;
    if (
      vix == null || !Number.isFinite(vix) || vix <= 0 ||
      !Number.isFinite(feedAgeMs) || feedAgeMs < -5_000 || feedAgeMs > 10 * 60_000
    ) return null;

    const [fiiDii, optionChain] = await Promise.all([
      fetchFIIDIIData(),
      fetchOptionChainData(),
    ]);
    if (
      !fiiDii || !Number.isFinite(fiiDii.fiiNetInr) || !optionChain ||
      !Number.isFinite(optionChain.pcr) || optionChain.pcr <= 0 ||
      !Number.isFinite(optionChain.fetchedAt.getTime())
    ) return null;
    const optionAgeMs = Date.now() - optionChain.fetchedAt.getTime();
    if (optionAgeMs < -5_000 || optionAgeMs > 15 * 60_000) return null;

    const fiiNet = fiiDii.fiiNetInr;
    const pcr = optionChain.pcr;

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

  // Private sigmoid rule diagnostics; no execution calibration artifact exists.
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
      p_execution_success: null,
      p_stop_hunt_risk: null,
      p_adverse_regime_shift: null,
      probability_validation: "not_established",
      confidence_kind: "decision_score_not_win_probability",
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
    // Heuristic diagnostics can reduce risk. They cannot establish execution
    // odds or authorize increasing the upstream capital budget.
    let sizeMultiplier: number;
    if (confidence >= 0.80 && pExec >= 0.70 && pHunt <= 0.20 && pShift <= 0.20 && ofiAligned) {
      sizeMultiplier = 1.0;
      gateReasons.push("UNVALIDATED_CONFIDENCE_CANNOT_INCREASE_SIZE");
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
      p_execution_success: null,
      p_stop_hunt_risk: null,
      p_adverse_regime_shift: null,
      probability_validation: "not_established",
      confidence_kind: "decision_score_not_win_probability",
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
      p_execution_success: null,
      p_stop_hunt_risk: null,
      p_adverse_regime_shift: null,
      probability_validation: "not_established",
      confidence_kind: "decision_score_not_win_probability",
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
      p_execution_success: null,
      p_stop_hunt_risk: null,
      p_adverse_regime_shift: null,
      probability_validation: "not_established",
      confidence_kind: "decision_score_not_win_probability",
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
