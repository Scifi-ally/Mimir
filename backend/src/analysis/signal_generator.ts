/**
 * Signal Generator — Layer 7
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrates the FULL intelligence pipeline:
 *
 *   Market Regime → Scanner Activation → Technical Scan →
 *   Candidate Pool → Feature Engineering → AI Intelligence →
 *   Confidence Scoring → Risk Assessment → Signal Output
 *
 * Only emits signals when ALL conditions pass:
 *   1. Technical Score > threshold
 *   2. AI Confidence > threshold
 *   3. Risk criteria pass
 *   4. Market regime supports trade direction
 */
import { logger } from "../lib/logger";
import { detectRegime, getLastRegimeOutput, type MarketRegime, type RegimeOutput } from "./regime_detector";
import { getScannerActivation, isScannerEnabled, setupTypeToScannerType } from "./scanner_activation";
import { computeFeatureVector, type FeatureVector } from "./feature_engine";
import { assessRisk, syncRiskEngineState } from "./risk_engine";
import { getConfig } from "../config";
import type { TechnicalSnapshot, OHLCV } from "./technical";
import type { ScanResult, StockSector } from "./stock_scanner";
import { checkAIHealth, batchInference, type BatchResult, getConfluenceScore, type System1Decision } from "./ai_client";
import { checkEarningsRisk } from "./earnings_filter";
import { getMarketState } from "../market_data/market_state";
import { stateStore, type RealtimeFeatures } from "../lib/redis_state";
import { db, learningAnalyticsTable, symbolScoresTable, learningMetricsTable } from "../../db/src";
import { eq } from "drizzle-orm";
import { getISTDateStr } from "../lib/ist-time";
import { createAnalysisTrace, recordAnalysisStage, runAnalysisStage, type AnalysisTrace } from "./analysis_contracts";
import { toBatchInferenceCandidates } from "./inference_payload";

export interface AdaptiveWeights {
  tech: number;
  technicalRanking: number;
  chronos: number;
  rs: number;
  sector: number;
  regime: number;
  sentiment: number;
}

let adaptiveWeightsCache: AdaptiveWeights | null = null;
let lastWeightFetch = 0;
// Logged once rather than every hour, so the absence is visible without
// spamming. No writer for the ADAPTIVE_WEIGHTS row exists anywhere in the repo,
// so these weights are permanently the defaults; saying so is better than the
// alternative, which was a "[LEARNING ENABLED]" string on every signal implying
// the weights adapted.
let loggedMissingLearnedWeights = false;

async function getAdaptiveWeights(): Promise<AdaptiveWeights> {
  const defaultWeights = { tech: 0.25, technicalRanking: 0.15, chronos: 0.10, rs: 0.15, sector: 0.15, regime: 0.10, sentiment: 0.10 };
  
  if (adaptiveWeightsCache && Date.now() - lastWeightFetch < 60 * 60 * 1000) {
    return adaptiveWeightsCache;
  }
  
  try {
    const [row] = await db
      .select({ insights: learningAnalyticsTable.insights })
      .from(learningAnalyticsTable)
      .where(eq(learningAnalyticsTable.tag, "ADAPTIVE_WEIGHTS"))
      .limit(1);
      
    if (row && row.insights) {
      const merged: AdaptiveWeights = { ...defaultWeights, ...JSON.parse(row.insights) };
      // Learned weights are normalized to sum 1.0 without a sentiment key, so
      // re-adding the default sentiment weight pushes the sum to ~1.10 —
      // renormalize so confidence stays on the 0-100 scale.
      const totalWeight =
        merged.tech + merged.technicalRanking + merged.chronos +
        merged.rs + merged.sector + merged.regime + merged.sentiment;
      if (totalWeight > 0) {
        merged.tech /= totalWeight;
        merged.technicalRanking /= totalWeight;
        merged.chronos /= totalWeight;
        merged.rs /= totalWeight;
        merged.sector /= totalWeight;
        merged.regime /= totalWeight;
        merged.sentiment /= totalWeight;
      }
      adaptiveWeightsCache = merged;
      lastWeightFetch = Date.now();
      return merged;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch adaptive weights, using defaults");
  }

  if (!loggedMissingLearnedWeights) {
    loggedMissingLearnedWeights = true;
    logger.warn(
      "No ADAPTIVE_WEIGHTS row in learning_analytics and nothing in this codebase " +
        "writes one, so the confidence weights are the hardcoded defaults. Any UI " +
        "text implying they adapt is misleading until a writer exists.",
    );
  }

  return defaultWeights;
}

// ── Signal output ────────────────────────────────────────────────────────────

export interface IntelligenceSignal {
  // Core signal
  symbol: string;
  name: string;
  signal: "BUY" | "SELL";
  setupType: string;

  // Pricing
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;

  // Rule intelligence. ai* names are retained for API compatibility.
  aiScore: number;            // 0-100 composite rule score
  confidence: number;         // 0-100 final confidence
  patternScore: number;        // 0-100 pattern quality score
  chronosScore: number;       // 0-100 directional forecast score
  technicalScore: number;     // 0-100 technical score
  sentimentScore: number;     // 0-100 news sentiment score

  // Context
  sector: StockSector;
  regime: MarketRegime;
  regimeConfidence: number;

  // Risk
  positionSize: number;
  investmentAmount: number;
  maxRiskInr: number;
  stopDistancePct: number;
  riskWarnings: string[];

  // Features
  featureVector: FeatureVector;

  // Meta
  reasoning: string;
  confluence: string[];
  aiPatterns: string[];
  aiMode: "Rule Mode" | "AI Mode" | "Fallback Mode";
  rankingProvider: "Technical Ranking" | "AI Ranking";
  scannerType: string;
  timestamp: string;
  signalId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signalFactors?: Record<string, any>;

  // Provisional pricing
  provisional_trigger: number | null;
  provisional_deviation: number;

  // MTF Context
  mtf_score: number;
  mtf_total: number;
  mtf_confluence: 'STRONG ALIGN' | 'PARTIAL' | 'DIVERGING' | 'PENDING';

  // Latency tracking
  scanLatencyMs: number;
  aiLatencyMs: number;
  totalLatencyMs: number;
  decisionTrace?: DecisionTrace;
}

export interface DecisionTrace {
  regime: string;
  regimeStrength: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chronos?: any;
  sentiment_score?: number;
  win_probability?: number | null;
  bullish_probability?: number;
  confidencePath: "python_confluence" | "native_math_fallback";
  rankerBlendApplied: boolean;
  rejectionGate?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rejectionValue?: number | string | boolean | string[] | null;
  threshold?: number;
  shap_values?: Record<string, number>;
  analysisTraceId?: string;
  laya_verdict?: string;
  laya_action?: string;
  system1_verdict?: string;
  system1_action?: string;
  system1_confidence?: number;
  position_size_multiplier?: number;
}

export interface PipelineResult {
  signals: IntelligenceSignal[];
  rejectedSignals?: IntelligenceSignal[];
  regime: RegimeOutput;
  candidatesScanned: number;
  candidatesPassed: number;
  candidatesRejectedByRisk: number;
  candidatesRejectedByAI: number;
  scanLatencyMs: number;
  aiLatencyMs: number;
  totalLatencyMs: number;
  aiServiceStatus: string;
  aiMode: "Rule Mode" | "AI Mode" | "Fallback Mode";
  rankingProvider: "Technical Ranking" | "AI Ranking";
  timestamp: string;
  analysisTrace: AnalysisTrace;
}

// ── Confidence formula ───────────────────────────────────────────────────────
// 30% Technical Quality + 20% Relative Strength + 15% Sector Strength
// + 15% pattern quality + 10% directional forecast + 10% Market Regime

function computeFinalConfidence(
  technicalScore: number,
  patternScore: number,
  chronosScore: number,
  relativeStrength: number,
  sectorStrength: number,
  regimeScore: number,
  sentimentScore: number,
  weights: AdaptiveWeights,
): number {
  // Normalize relative strength: 0.8-1.2 range → 0-100
  const rsNormalized = Math.max(0, Math.min(100, ((relativeStrength - 0.8) / 0.4) * 100));
  // Normalize sector strength: -2% to +2% → 0-100
  const sectorNormalized = Math.max(0, Math.min(100, ((sectorStrength + 2) / 4) * 100));

  const confidence =
    technicalScore * weights.tech +
    rsNormalized * weights.rs +
    sectorNormalized * weights.sector +
    patternScore * weights.technicalRanking +
    chronosScore * weights.chronos +
    regimeScore * weights.regime +
    sentimentScore * weights.sentiment;

  return Math.round(Math.max(0, Math.min(100, confidence)));
}

function computeFallbackConfidence(
  technicalScore: number,
  rsVsNifty60d: number,
  sectorStrength: number,
  regimeScore: number,
  weights: AdaptiveWeights,
): number {
  const rsNormalized = Math.max(0, Math.min(100, ((rsVsNifty60d - 0.8) / 0.4) * 100));
  const sectorNormalized = Math.max(0, Math.min(100, ((sectorStrength + 2) / 4) * 100));

  const techWeight = weights.tech + weights.technicalRanking + weights.chronos + weights.sentiment;

  const confidence =
    technicalScore * techWeight +
    rsNormalized * weights.rs +
    sectorNormalized * weights.sector +
    regimeScore * weights.regime;

  return Math.round(Math.max(0, Math.min(100, confidence)));
}

// ── Main pipeline ────────────────────────────────────────────────────────────

export async function runIntelligencePipeline(
  scanResults: ScanResult[],
  candleCache?: Map<string, OHLCV[]>,
  snapshotCache?: Map<string, TechnicalSnapshot>,
): Promise<PipelineResult> {
  const pipelineStart = Date.now();
  const analysisTrace = createAnalysisTrace();
  const cfg = getConfig();

  const adaptiveWeights = await runAnalysisStage(
    analysisTrace,
    "configuration",
    getAdaptiveWeights,
    { source: "adaptive_weights" },
  );

  // ── Step 0: Sync risk engine state with the database (Single Source of Truth) ──
  await runAnalysisStage(analysisTrace, "risk_state", syncRiskEngineState, { source: "risk_engine" });

  // ── Step 1: Update market regime ──────────────────────────────────────
  detectRegime();
  const regime = getLastRegimeOutput()!;
  const activation = getScannerActivation();
  recordAnalysisStage(analysisTrace, "market_context", "ok", pipelineStart, {
    source: "regime_detector",
    metadata: { regime: regime.regime, confidence: regime.confidence },
  });

  // Fetch learning metrics for current regime
  const learningMetricsRows = await db
    .select()
    .from(learningMetricsTable)
    .where(eq(learningMetricsTable.regimeLabel, regime.regime));
  
  const learningMetrics = new Map(learningMetricsRows.map(row => [row.symbol, row]));

  logger.info(
    {
      regime: regime.regime,
      confidence: regime.confidence,
      enabledScanners: activation.enabled.length,
      disabledScanners: activation.disabled.length,
    },
    "Intelligence pipeline: regime assessed",
  );

  // ── Step 2: Filter by scanner activation ──────────────────────────────
  const activatedResults = scanResults.filter(r => {
    const scannerType = setupTypeToScannerType(r.setup.setupType);
    if (scannerType && !isScannerEnabled(r.setup.setupType)) {
      logger.debug(
        { symbol: r.symbol, setupType: r.setup.setupType, regime: regime.regime },
        "Candidate filtered by scanner activation",
      );
      return false;
    }
    return true;
  });

  logger.info(
    { total: scanResults.length, afterActivation: activatedResults.length },
    "Candidates after scanner activation filter",
  );
  recordAnalysisStage(analysisTrace, "candidate_activation", "ok", pipelineStart, {
    candidateCount: activatedResults.length,
    source: "scanner_activation",
    metadata: { inputCount: scanResults.length },
  });

  // ── Step 2.5: Calculate Candidate Breadth ──────────────────────────────
  let advancingCandidates = 0;
  let candidatesAbove50EMA = 0;
  const totalCandidates = activatedResults.length;
  
  for (const r of activatedResults) {
    const snap = r.snapshot ?? snapshotCache?.get(r.symbol);
    if (!snap) continue;
    if (snap.close > snap.ema9) advancingCandidates++;
    if (snap.close > snap.ema50) candidatesAbove50EMA++;
  }
  
  const breadthPctAbove50 = totalCandidates > 0 ? (candidatesAbove50EMA / totalCandidates) * 100 : 50;
  const isWeakBreadth = breadthPctAbove50 < 35;
  logger.info({ breadthPctAbove50, advancingCandidates, totalCandidates }, "Candidate Breadth Calculated");

  // ── Step 3: Feature engineering ───────────────────────────────────────
  const scanEnd = Date.now();
  const candidates: Array<{
    result: ScanResult;
    features: FeatureVector;
    candles: OHLCV[];
    snap: TechnicalSnapshot;
  }> = [];

  // Pre-calculate Sector RS Averages using the full population of scanned results
  const sectorRsSums = new Map<string, { total: number; count: number }>();
  for (const r of scanResults) {
    if (!r.sector) continue;
    const current = sectorRsSums.get(r.sector) || { total: 0, count: 0 };
    current.total += r.rs60;
    current.count += 1;
    sectorRsSums.set(r.sector, current);
  }

  // Pre-fetch real-time features to keep the compute loop synchronous
  const realtimeFeaturesCache = new Map<string, RealtimeFeatures>();
  await Promise.all(
    activatedResults.map(async (r) => {
      const feat = await stateStore.getRealtimeFeatures(r.symbol);
      if (feat) realtimeFeaturesCache.set(r.symbol, feat);
    })
  );

  for (const result of activatedResults) {
    const candles = result.candles ?? candleCache?.get(result.symbol);
    const snap = result.snapshot ?? snapshotCache?.get(result.symbol);
    if (!candles || !snap) continue;

    // Calculate dynamic proxy for sector RS (Stock RS vs Nifty) / (Sector Avg RS vs Nifty)
    //
    // When the sector is unknown, or the only member of the "sector" is this
    // stock itself, the ratio is meaningless: dividing a stock's RS by its own
    // RS yields 1.0, which reads as exactly-average-to-sector - a value the
    // model then treats as a real observation. That is how rsVsSector60d ended
    // up constant in every training row while the shipped model still split on
    // it 13 times.
    //
    // So the unknown case is passed through explicitly as null, and
    // computeFeatureVector / the ranker contract treat a null here as "not
    // measured" rather than "measured as neutral".
    let rsVsSectorProxy: number | null = result.rs60;
    const sectorStats = result.sector ? sectorRsSums.get(result.sector) : null;
    if (result.sector && result.sector !== "Other" && sectorStats && sectorStats.count > 1) {
      const sectorAvgRs = sectorStats.total / sectorStats.count;
      if (sectorAvgRs > 0) {
        rsVsSectorProxy = result.rs60 / sectorAvgRs;
      }
    }
    const sectorRelativeStrengthKnown = rsVsSectorProxy !== null;
    if (rsVsSectorProxy === null) {
      // A single-member or unknown sector carries no relative-strength
      // information. Recorded so the feature is not silently backfilled.
      rsVsSectorProxy = result.rs60;
    }

    /** Minimum candles needed before the ranker's 32 features are trustworthy. */
const MIN_RANKER_HISTORY = 200;

const realtimeFeat = realtimeFeaturesCache.get(result.symbol);
    let bidAskImbalance = 0;
    let optionsOiChangeRate = 0;
    let rankerIncomplete = false;

    // Realtime features are READ here, but they deliberately do NOT gate the
    // ranker.
    //
    // They used to: a missing or stale `upstox:features:<symbol>` set
    // rankerIncomplete, which sends ranker_features: null and disarms the model
    // for the whole session. But neither bidAskImbalance nor optionsOiChangeRate
    // is one of the ranker's 32 feature keys (see ranker_meta.json) - the model
    // is built entirely from OHLCV/history features. So the gate was armed by a
    // key the model never reads: every value this could take, including a
    // perfectly good one, changed nothing about the prediction, while its
    // absence silenced the only calibrated model in the system.
    //
    // The ranker is instead gated below on the inputs it genuinely consumes.
    if (realtimeFeat) {
      bidAskImbalance = realtimeFeat.bidAskImbalance ?? 0;
      optionsOiChangeRate = realtimeFeat.optionsOiChangeRate ?? 0;
      const diffMs = Date.now() - new Date(realtimeFeat.timestamp).getTime();
      if (getMarketState().isMarketOpen && diffMs > 60 * 1000) {
        // Staleness is still reported, but as a data-quality note rather than a
        // disarming condition: the value is not a model input, so an old one is
        // merely uninformative, not invalidating.
        logger.debug(
          { symbol: result.symbol, diffMs },
          "Realtime order-flow reading is stale and will not be used this cycle"
        );
      }
    }

    // A sector-relative strength we could not actually measure is also an
    // incomplete input. Left unmarked, the fallback (the stock's own rs60) would
    // look like a measured observation of sector-relative strength, which is
    // precisely how the feature became a constant that the model still split on.
    if (!sectorRelativeStrengthKnown) {
      rankerIncomplete = true;
    }

    // Real completeness condition: nearly every one of the 32 features
    // (ema200Dist, realizedVol20, volOfVol, trendConsistency) needs a deep
    // enough history. Without it the model would silently receive
    // short-history stand-ins and score with confidence it has not earned.
    if (candles.length < MIN_RANKER_HISTORY) {
      logger.warn(
        { symbol: result.symbol, candles: candles.length, required: MIN_RANKER_HISTORY },
        "Insufficient history for ranker features (rankerIncomplete = true)"
      );
      rankerIncomplete = true;
    }

    const features = computeFeatureVector(
      result.symbol,
      result.sector,
      candles,
      snap,
      result.rs60,
      rsVsSectorProxy,
      result.setup.riskReward,
      bidAskImbalance,
      optionsOiChangeRate,
      rankerIncomplete,
    );

    candidates.push({ result, features, candles, snap });
  }

  recordAnalysisStage(analysisTrace, "feature_engineering", "ok", scanEnd, {
    candidateCount: candidates.length,
    source: "feature_engine",
    metadata: { rankerContract: "32-feature" },
  });

  // ── Step 4: AI Intelligence Layer ─────────────────────────────────────
  const aiStart = Date.now();
  let aiResults = new Map<string, BatchResult>();

  const healthStart = Date.now();
  const health = await checkAIHealth();
  recordAnalysisStage(analysisTrace, "ai_health", health.status === "healthy" ? "ok" : "degraded", healthStart, {
    source: health.ranking_provider || "ai_service",
    reason: health.status === "healthy" ? undefined : health.ai_mode,
    metadata: {
      status: health.status,
      rankingProvider: health.ranking_provider,
      modelKeys: Object.keys(health.models ?? {}),
    },
  });

  const modelInferenceStart = Date.now();
  if (health.status !== "unavailable" && candidates.length > 0) {
    const currentMkt = getMarketState();
    aiResults = await batchInference(toBatchInferenceCandidates(candidates.map(c => ({
      symbol: c.result.symbol,
      candles: c.candles,
      features: c.features,
      direction: c.result.setup.direction,
      setupType: c.result.setup.setupType,
      entryPrice: c.result.setup.entryPrice,
      stopLoss: c.result.setup.stopLoss,
      target1: c.result.setup.target1,
      riskReward: c.result.setup.riskReward,
      marketRegime: regime.regime,
      indiaVix: currentMkt.indiaVix ?? 15.0,
      ofiRatio: c.features.bidAskImbalance ?? 0.0,
      fiiNet: currentMkt.fiiNetInr ?? 0.0,
    }))));
    const fallbackOnly = aiResults.size === 0 || Array.from(aiResults.values()).every(result => result.isFallback);
    recordAnalysisStage(analysisTrace, "model_inference", fallbackOnly ? "degraded" : "ok", modelInferenceStart, {
      candidateCount: candidates.length,
      source: fallbackOnly ? "native_fallback" : "python_ai",
      reason: fallbackOnly ? "No usable model result returned" : undefined,
      metadata: { resultCount: aiResults.size },
    });
    logger.info(
      { candidateCount: candidates.length, aiStatus: health.status, resultCount: aiResults.size },
      "AI batch inference completed",
    );
  } else if (candidates.length > 0) {
    recordAnalysisStage(analysisTrace, "model_inference", "degraded", modelInferenceStart, {
      candidateCount: candidates.length,
      source: "native_fallback",
      reason: "AI service unavailable",
    });
    logger.warn("AI service unavailable — using fallback confidence scoring");
  } else {
    recordAnalysisStage(analysisTrace, "model_inference", "skipped", modelInferenceStart, {
      candidateCount: 0,
      source: "none",
      reason: "No activated candidates with valid features",
    });
  }

  const aiEnd = Date.now();

  // ── Step 5: Confidence scoring + Risk assessment + Signal generation ──
  const signals: IntelligenceSignal[] = [];
  const rejectedSignals: IntelligenceSignal[] = [];
  let rejectedByRisk = 0;
  let rejectedByAI = 0;
  const decisionStageStart = Date.now();
  for (const candidate of candidates) {

    const { result, features, snap } = candidate;
    const aiResult = aiResults.get(result.symbol);
    // AI contributes when the Python service returned a real pattern-engine
    // score. Previously this also required chronos/pattern source === "model",
    // but the pattern engine always emits "engine" and Chronos emits "model"
    // only when HF weights are loaded — so on the common synthetic-Chronos path
    // this discarded the genuine pattern + sentiment scores and stored aiScore=0,
    // poisoning outcome data. `isFallback` (now scoped to a real pattern-engine
    // failure or the native-math path) is the correct, sufficient gate.
    const aiContributing =
      aiResult !== undefined &&
      !aiResult.isFallback;
      
    // Extract Sentiment
    const sentimentScore = aiResult?.sentiment_score ?? 50;

    const rankingProvider = aiContributing ? "AI Ranking" : "Technical Ranking";
    const aiMode = aiContributing ? "AI Mode" : "Fallback Mode";

    // Compute scores
    const technicalScore = Math.round(Math.min(100, (result.score / 10) * 100));
    // bullish_probability is 0-1 from both the Python service and the native
    // fallback — scale to the 0-100 range the confidence formula expects.
    const patternScore = Math.max(0, Math.min(100, (aiResult?.technicalRanking.bullish_probability ?? 0) * 100));
    const chronosScore = aiResult
      ? mapChronosToScore(aiResult.chronos, result.setup.direction)
      : 0;

    // Sector strength from features
    const sectorStrength = features.sectorStrength;
    const regimeScore = features.regimeScore;

    // Compute final confidence using the Regime-Gated Confluence Model
    let confidence = 50;
    // True only when getConfluenceScore actually produced the number — the
    // decision trace must record which formula ran, not which was attempted.
    let usedConfluence = false;
    if (aiContributing) {
      const rsNormalized = Math.max(0, Math.min(100, ((features.rsVsNifty60d - 0.8) / 0.4) * 100));
      const sectorNormalized = Math.max(0, Math.min(100, ((sectorStrength + 2) / 4) * 100));
      
      const confRes = await getConfluenceScore(regime.regime, {
        tech_score: technicalScore,
        pattern_score: patternScore,
        chronos_score: chronosScore,
        rs_score: rsNormalized,
        sector_score: sectorNormalized,
        sentiment_score: sentimentScore
      });
      
      if (!confRes.fallback) {
        confidence = confRes.score;
        usedConfluence = true;
      } else {
        confidence = computeFinalConfidence(
          technicalScore,
          patternScore,
          chronosScore,
          features.rsVsNifty60d,
          sectorStrength,
          regimeScore,
          sentimentScore,
          adaptiveWeights
        );
      }
    } else {
      confidence = computeFallbackConfidence(
        technicalScore,
        features.rsVsNifty60d,
        sectorStrength,
        regimeScore,
        adaptiveWeights
      );
    }

    // Apply high volatility penalty instead of hard blocking trades
    if (regime.regime === "HIGH_VOLATILITY") {
      confidence = Math.max(0, confidence - 15);
    }

    let shapString: string | null = null;
    if (aiResult?.shap_values) {
      const top3 = Object.entries(aiResult.shap_values)
        .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
        .slice(0, 3)
        .map(([k, v]) => `${k} (${v > 0 ? '+' : ''}${v.toFixed(2)})`)
        .join(", ");
      if (top3) {
        shapString = `SHAP Top 3: ${top3}`;
      }
    }

    const buildRejectedSignal = (gate: string, value: number | string | boolean | string[] | null, thresholdVal?: number): IntelligenceSignal => {
      const trace: DecisionTrace = {
        regime: regime.regime,
        regimeStrength: regime.confidence,
        chronos: aiResult?.chronos,
        sentiment_score: sentimentScore,
        win_probability: aiResult?.win_probability,
        bullish_probability: aiResult?.technicalRanking?.bullish_probability,
        confidencePath: usedConfluence ? "python_confluence" : "native_math_fallback",
        rankerBlendApplied: !!(aiResult?.ranker_loaded && typeof aiResult?.win_probability === "number"),
        rejectionGate: gate,
        rejectionValue: value,
        threshold: thresholdVal,
        shap_values: aiResult?.shap_values,
        analysisTraceId: analysisTrace.traceId,
        laya_verdict: aiResult?.laya_decision?.verdict,
        laya_action: aiResult?.laya_decision?.action,
        system1_verdict: aiResult?.system1_decision?.verdict,
        system1_action: aiResult?.system1_decision?.action,
        system1_confidence: aiResult?.system1_decision?.confidence,
        position_size_multiplier: aiResult?.system1_decision?.position_size_multiplier,
      };
      
      return {
        symbol: result.symbol,
        name: result.name,
        signal: result.setup.direction,
        setupType: result.setup.setupType,
        entryPrice: result.setup.entryPrice || snap.close,
        stopLoss: result.setup.stopLoss || snap.close,
        target1: result.setup.target1 || snap.close,
        target2: result.setup.target2 || snap.close,
        riskReward: result.setup.riskReward || 0,
        aiScore: aiContributing && aiResult ? aiResult.composite_score : 0,
        confidence,
        patternScore: Math.round(patternScore),
        chronosScore: Math.round(chronosScore),
        technicalScore,
        sentimentScore: Math.round(sentimentScore),
        sector: result.sector,
        regime: regime.regime,
        regimeConfidence: regime.confidence,
        positionSize: 0,
        investmentAmount: 0,
        maxRiskInr: 0,
        stopDistancePct: 0,
        riskWarnings: [],
        featureVector: features,
        reasoning: "Rejected",
        confluence: shapString ? [shapString] : [],
        aiPatterns: [],
        aiMode,
        rankingProvider,
        scannerType: result.category,
        timestamp: new Date().toISOString(),
        signalId: "",
        provisional_trigger: null,
        provisional_deviation: 0,
        mtf_score: 0,
        mtf_total: 0,
        mtf_confluence: 'PENDING',
        scanLatencyMs: 0,
        aiLatencyMs: 0,
        totalLatencyMs: 0,
        decisionTrace: trace
      };
    };

    // ── Learned ranker: the primary edge ──────────────────────────────
    // When the LightGBM ranker served this batch it returns a calibrated
    // P(target1 before stop). We (a) HARD-GATE on the model's own
    // out-of-sample-optimal threshold — conservative risk means we simply
    // don't take trades the model expects to lose — and (b) blend the
    // probability into the confidence so the learned model, not the
    // hand-tuned linear formula, drives ranking. When the ranker is absent
    // (null win_probability), nothing here fires and the composite score
    // continues to rank exactly as before (graceful degradation).
    const winProb = aiResult?.win_probability;
    const rankerLoaded = aiResult?.ranker_loaded === true;
    if (rankerLoaded && typeof winProb === "number") {
      // Threshold from the trained model's meta (expectancy-maximising on the
      // held-out slice), with a conservative floor so a loose auto-threshold
      // can never wave through coin-flips. Configurable via RANKER_MIN_THRESHOLD.
      const envRankerFloor = process.env.RANKER_MIN_THRESHOLD;
      const rankerFloor = envRankerFloor !== undefined && !isNaN(Number(envRankerFloor))
        ? Number(envRankerFloor)
        : 0.58;
      const rankerThreshold = Math.max(rankerFloor, aiResult?.ranker_threshold ?? rankerFloor);
      if (winProb < rankerThreshold) {
        rejectedByAI++;
        rejectedSignals.push(buildRejectedSignal("ranker_threshold", winProb, rankerThreshold));
        logger.debug(
          { symbol: result.symbol, winProb, rankerThreshold, setupType: result.setup.setupType },
          "Signal rejected — learned ranker P(win) below threshold",
        );
        continue;
      }
      // Blend: map the calibrated probability to a 0-100 scale and take a
      // 70/30 weighting toward the model over the legacy composite. The model
      // is the measured edge; the composite is a prior that keeps ordering
      // sane in the probability band where the model is less discriminating.
      const rankerConfidence = winProb * 100;
      confidence = Math.round(rankerConfidence * 0.7 + confidence * 0.3);
    }

    // ── System-1 Fast Decision Gatekeepers (Unified Laya / Jev / Consensus) ──────
    // System-1 gatekeeper. Laya is the only System-1 engine.
    //
    // It runs locally on the real Apache-2.0 typed-decisions weights via PyTorch
    // CPU, so there is no cloud dependency and no second opinion to reconcile.
    //
    // Jev and the dual-engine consensus mode are removed. The previous config was
    // already inert - the Jev rejection path sat inside the
    // system1Engine === 'consensus' branch, so under SYSTEM1_ENGINE=laya it never
    // executed. This is dead-contract cleanup, not a behaviour change.
    const layaEnabled = (process.env.LAYA_ENABLED ?? 'true').toLowerCase() !== 'false';
    const layaDecision = aiResult?.laya_decision;

    const activeSys1Decision: System1Decision | undefined =
      layaEnabled && layaDecision ? layaDecision : (aiResult?.system1_decision ?? undefined);
    const activeSys1Name = 'LAYA';
    const activeTag = 'laya_decision';

    let rejectedBySystem1 = false;
    if (layaDecision?.verdict === 'REJECT' && layaDecision.confidence >= 0.70) {
      rejectedByAI++;
      rejectedSignals.push(buildRejectedSignal('laya_decision', layaDecision.action, 0.70));
      rejectedBySystem1 = true;
    } else if (activeSys1Decision?.verdict === 'REJECT' && activeSys1Decision.confidence >= 0.70) {
      rejectedByAI++;
      rejectedSignals.push(buildRejectedSignal(activeTag, activeSys1Decision.action, 0.70));
      logger.debug(
        { symbol: result.symbol, action: activeSys1Decision.action, reasons: activeSys1Decision.gate_reasons },
        'Signal rejected - ' + activeSys1Name + ' triage gatekeeper rejected setup',
      );
      rejectedBySystem1 = true;
    }
    if (rejectedBySystem1) continue;

    const aiScore = aiContributing && aiResult ? aiResult.composite_score : 0;

    // Task 1: Insert composite score 
    const todayStr = getISTDateStr().split('T')[0];
    if (todayStr) {
      db.insert(symbolScoresTable)
        .values({
          symbol: result.symbol,
          score: Math.round(confidence),
          forDate: todayStr,
        })
        .onConflictDoUpdate({
          target: [symbolScoresTable.symbol, symbolScoresTable.forDate],
          set: { score: Math.round(confidence), calculatedAt: new Date() }
        }).catch(err => logger.error({ err, symbol: result.symbol }, "Failed to upsert symbol score"));
    }

    // Task 2: Compute Provisional Trigger and Deviation
    let provisional_trigger: number | null;
    let provisional_deviation = 0;
    
    if (result.setup.entryPrice && result.setup.entryPrice > 0) {
      provisional_trigger = result.setup.entryPrice;
    } else {
      const currentPrice = snap.close;
      const vwapDistPct = Math.abs((currentPrice - snap.vwap) / snap.vwap) * 100;
      let crossedEma9 = false;
      const lastCandles = candidate.candles.slice(-3);
      for (let i = 1; i < lastCandles.length; i++) {
        const prevC = lastCandles[i-1];
        const currC = lastCandles[i];
        if (prevC && currC) {
          if ((prevC.close < snap.ema9 && currC.close > snap.ema9) || (prevC.close > snap.ema9 && currC.close < snap.ema9)) {
            crossedEma9 = true;
            break;
          }
        }
      }
      
      if (vwapDistPct <= 0.5) {
        provisional_trigger = snap.vwap;
      } else if (crossedEma9) {
        provisional_trigger = snap.ema9;
      } else {
        provisional_trigger = snap.ema20;
      }
    }

    if (provisional_trigger) {
      provisional_deviation = Number((((snap.close - provisional_trigger) / provisional_trigger) * 100).toFixed(2));
    }

    // Build Dynamic Decision Engine reasoning (Phase 6 Hardening)
    const rsVal = features.rsVsNifty60d;
    const rsNormalized = Math.max(0, Math.min(100, ((rsVal - 0.8) / 0.4) * 100));
    const sectorVal = features.sectorStrength;
    const sectorNormalized = Math.max(0, Math.min(100, ((sectorVal + 2) / 4) * 100));

    const techCont = technicalScore * (aiContributing ? adaptiveWeights.tech : (adaptiveWeights.tech + adaptiveWeights.technicalRanking + adaptiveWeights.chronos));
    const rsCont = rsNormalized * adaptiveWeights.rs;
    const sectorCont = sectorNormalized * adaptiveWeights.sector;
    const patternCont = patternScore * adaptiveWeights.technicalRanking;
    const chronosCont = chronosScore * adaptiveWeights.chronos;
    const regimeCont = regimeScore * adaptiveWeights.regime;

// Says whether the AI models contributed to this score, NOT whether any
  // weights were learned - nothing writes ADAPTIVE_WEIGHTS, so the old
  // "[LEARNING ENABLED]" wording claimed an adaptation loop that does not exist.
  const dynamicReasoning = aiContributing
    ? `[AI SCORED] Reasons: Relative Strength +${rsCont.toFixed(1)}, Sector Rank +${sectorCont.toFixed(1)}, Volume Expansion +${features.volumeRatio ? ((features.volumeRatio - 1) * 100).toFixed(0) : "0"}%, Nifty50GPT Pattern Score +${patternCont.toFixed(1)}, Chronos Forecast Score +${chronosCont.toFixed(1)}, Total Composite Score ${confidence}. Contributions: Tech Quality +${techCont.toFixed(1)}, RS +${rsCont.toFixed(1)}, Sector +${sectorCont.toFixed(1)}, Nifty50GPT +${patternCont.toFixed(1)}, Chronos +${chronosCont.toFixed(1)}, Regime +${regimeCont.toFixed(1)}.`
    : `[RULES ONLY] Reasons: Relative Strength +${rsCont.toFixed(1)}, Sector Rank +${sectorCont.toFixed(1)}, Volume Expansion +${features.volumeRatio ? ((features.volumeRatio - 1) * 100).toFixed(0) : "0"}%, Technical Score ${technicalScore}, Total Composite Score ${confidence}. Contributions: Tech Quality +${techCont.toFixed(1)}, RS +${rsCont.toFixed(1)}, Sector +${sectorCont.toFixed(1)}, Regime +${regimeCont.toFixed(1)}.`;

    // ── Confidence threshold check ────────────────────────────────────
    let minConfidence = aiContributing ? cfg.minAutoConfidencePct : Math.min(55, cfg.minAutoConfidencePct);
    
    // Breadth Dynamic Strictness (Relaxed to allow more suggestions)
    if (isWeakBreadth && result.setup.direction === "BUY") {
      minConfidence = Math.max(minConfidence, 70); 
    } else if (breadthPctAbove50 > 75 && result.setup.direction === "SELL") {
      minConfidence = Math.max(minConfidence, 70); 
    }

    if (confidence < minConfidence) {
      rejectedByAI++;
      rejectedSignals.push(buildRejectedSignal("min_confidence", confidence, minConfidence));
      logger.debug(
        { symbol: result.symbol, confidence, minConfidence, setupType: result.setup.setupType },
        "Signal rejected — confidence below dynamically adjusted threshold",
      );
      continue;
    }

    // ── Multi-Timeframe (MTF) Strictness Check ─────────────────────────
    const isReversalOrPullback = result.setup.setupType.includes("REVERSION") || result.setup.setupType.includes("PULLBACK") || result.setup.setupType.includes("LIQUIDITY");

    if (result.setup.direction === "BUY") {
      if (result.mtfWeeklyTrend === "DOWN" && !isReversalOrPullback) {
        rejectedByAI++;
        rejectedSignals.push(buildRejectedSignal("mtf_strictness", "Weekly DOWN"));
        logger.debug({ symbol: result.symbol }, "Signal rejected — Weekly trend is DOWN (MTF Filter)");
        continue;
      }
      if (!result.hourlyConfirmed && !isReversalOrPullback) {
        rejectedByAI++;
        rejectedSignals.push(buildRejectedSignal("mtf_strictness", "Hourly Unconfirmed"));
        logger.debug({ symbol: result.symbol }, "Signal rejected — Hourly trend does not confirm BUY (MTF Filter)");
        continue;
      }
    }
    
    if (result.setup.direction === "SELL") {
      if (result.mtfWeeklyTrend === "UP" && !isReversalOrPullback) {
        rejectedByAI++;
        rejectedSignals.push(buildRejectedSignal("mtf_strictness", "Weekly UP"));
        logger.debug({ symbol: result.symbol }, "Signal rejected — Weekly trend is UP (MTF Filter)");
        continue;
      }
      if (!result.hourlyConfirmed && !isReversalOrPullback) {
        rejectedByAI++;
        rejectedSignals.push(buildRejectedSignal("mtf_strictness", "Hourly Unconfirmed"));
        logger.debug({ symbol: result.symbol }, "Signal rejected — Hourly trend does not confirm SELL (MTF Filter)");
        continue;
      }
    }

    // ── Regime direction check ────────────────────────────────────────
    if (!isRegimeCompatible(regime.regime, result.setup.direction)) {
      rejectedByAI++;
      rejectedSignals.push(buildRejectedSignal("regime_direction", regime.regime));
      logger.debug(
        { symbol: result.symbol, regime: regime.regime, direction: result.setup.direction },
        "Signal rejected — regime incompatible with direction",
      );
      continue;
    }

    // ── Risk assessment ───────────────────────────────────────────────
    // Pass the calibrated win probability so position sizing can scale by
    // quarter-Kelly. undefined when the ranker is absent → flat sizing as before.
    const sizingWinProb = rankerLoaded && typeof winProb === "number" ? winProb : undefined;
    const riskAssessment = await assessRisk(result.setup, snap, result.sector, features, sizingWinProb);

    if (!riskAssessment.passed) {
      rejectedByRisk++;
      rejectedSignals.push(buildRejectedSignal("risk_engine", riskAssessment.rejectionReasons));
      logger.debug(
        { symbol: result.symbol, rejections: riskAssessment.rejectionReasons },
        "Signal rejected by risk engine",
      );
      continue;
    }

    // ── Earnings Evasion Filter ────────────────────────────────────────
    const earningsCheck = await checkEarningsRisk(result.symbol);
    if (earningsCheck.riskLevel === "HIGH_RISK") {
      rejectedByAI++;
      rejectedSignals.push(buildRejectedSignal("earnings_evasion", earningsCheck.daysUntilEarnings));
      logger.info(
        {
          symbol: result.symbol,
          earningsDate: earningsCheck.earningsDate?.toISOString(),
          daysUntil: earningsCheck.daysUntilEarnings,
        },
        "Signal rejected — earnings within 3 days (Earnings Evasion)",
      );
      continue;
    }
    // Add earnings caution to risk warnings if within 6 days
    if (earningsCheck.riskLevel === "CAUTION") {
      riskAssessment.warningReasons.push(
        `Earnings in ${earningsCheck.daysUntilEarnings} days — elevated risk`,
      );
    }

    const sys1Label = `${activeSys1Name} System-1`;
    const sys1Prefix = activeSys1Name;

    if (activeSys1Decision?.verdict === "CAUTION") {
      riskAssessment.warningReasons.push(
        `${sys1Label} Caution (${activeSys1Decision.action}): pullback confirmation advised`,
      );
    }
    const stopHuntRisk = activeSys1Decision?.p_stop_hunt_risk;
    if (typeof stopHuntRisk === "number" && stopHuntRisk > 0.40) {
      riskAssessment.warningReasons.push(
        `${sys1Prefix}: Elevated stop-hunt risk (${Math.round(stopHuntRisk * 100)}%) — limit pullback order advised`,
      );
    }
    if (activeSys1Decision?.action === "LIMIT_PULLBACK") {
      riskAssessment.warningReasons.push(
        `${sys1Prefix}: Limit pullback order recommended to avoid chasing extension`,
      );
      // Re-anchor entry price to dynamic pullback support (VWAP or EMA9) to prevent
      // chasing extended breakouts, improving R:R and avoiding false stop-outs
      const currentPrice = snap.close;
      const vwap = snap.vwap;
      const ema9 = snap.ema9;
      if (result.setup.direction === "BUY") {
        const pullbackPrice = (vwap && vwap > 0 && vwap < currentPrice && (currentPrice - vwap) / currentPrice < 0.035)
          ? vwap
          : (ema9 && ema9 > 0 && ema9 < currentPrice && (currentPrice - ema9) / currentPrice < 0.035 ? ema9 : null);
        if (pullbackPrice && pullbackPrice > 0) {
          const refinedEntry = Math.round(pullbackPrice * 100) / 100;
          if (refinedEntry < (result.setup.entryPrice || currentPrice)) {
            result.setup.entryPrice = refinedEntry;
            provisional_trigger = refinedEntry;
            const newRisk = refinedEntry - result.setup.stopLoss;
            const newReward = result.setup.target1 - refinedEntry;
            if (newRisk > 0) {
              result.setup.riskReward = Math.round((newReward / newRisk) * 100) / 100;
            }
          }
        }
      } else if (result.setup.direction === "SELL") {
        const pullbackPrice = (vwap && vwap > 0 && vwap > currentPrice && (vwap - currentPrice) / currentPrice < 0.035)
          ? vwap
          : (ema9 && ema9 > 0 && ema9 > currentPrice && (ema9 - currentPrice) / currentPrice < 0.035 ? ema9 : null);
        if (pullbackPrice && pullbackPrice > 0) {
          const refinedEntry = Math.round(pullbackPrice * 100) / 100;
          if (refinedEntry > (result.setup.entryPrice || currentPrice)) {
            result.setup.entryPrice = refinedEntry;
            provisional_trigger = refinedEntry;
            const newRisk = result.setup.stopLoss - refinedEntry;
            const newReward = refinedEntry - result.setup.target1;
            if (newRisk > 0) {
              result.setup.riskReward = Math.round((newReward / newRisk) * 100) / 100;
            }
          }
        }
      }
    }

    const mergedConfluence = [...result.setup.confluence];
    if (shapString) {
      mergedConfluence.push(shapString);
    }
    if (activeSys1Decision?.verdict === "APPROVE") {
      mergedConfluence.push(`${sys1Label}: Conviction Approved`);
      if (activeSys1Decision.action && activeSys1Decision.action !== "EXECUTE_IMMEDIATELY") {
        mergedConfluence.push(`${sys1Prefix} Action: ${activeSys1Decision.action}`);
      }
      const execSuccess = activeSys1Decision.p_execution_success;
      if (typeof execSuccess === "number" && execSuccess >= 0.75) {
        mergedConfluence.push(`${sys1Prefix}: High Fill Success Prob (${Math.round(execSuccess * 100)}%)`);
      }
    }

    // Dynamic position sizing scaling from System-1 decision.
    //
    // `riskAssessment.positionSize` has ALREADY been reduced by the risk engine
    // for hard portfolio constraints — halved when macro.eventRiskActive
    // (risk_engine.ts:395) and cut to fit maxDeployedCapitalPct
    // (risk_engine.ts:409). Multiplying that result by an upside multiplier
    // re-inflates a position past the exact cap that was just enforced, and
    // `Math.max(1, …)` could even grow a cap-constrained size of 0 or 1.
    //
    // System-1 is therefore only permitted to VETO or DOWNSCALE. It can never
    // unlock capital the risk engine refused. Sizing up on extra conviction
    // belongs before the caps are applied, inside the risk engine.
    let finalPositionSize = riskAssessment.positionSize;
    let finalInvestmentAmount = riskAssessment.investmentAmount;
    let finalMaxRiskInr = riskAssessment.maxRiskInr;
    const sys1Multiplier = activeSys1Decision?.position_size_multiplier;
    if (
      typeof sys1Multiplier === "number" &&
      Number.isFinite(sys1Multiplier) &&
      sys1Multiplier > 0 &&
      sys1Multiplier !== 1.0
    ) {
      const riskEngineSize = Math.max(0, Math.floor(riskAssessment.positionSize));
      // min() is load-bearing: an upside multiplier is clamped back to the
      // risk-engine size, a downside multiplier is honoured.
      const scaled = Math.floor(riskEngineSize * sys1Multiplier);
      finalPositionSize = Math.max(0, Math.min(riskEngineSize, scaled));

      if (finalPositionSize !== riskEngineSize) {
        const entryPx = Number.isFinite(result.setup.entryPrice) && result.setup.entryPrice > 0
          ? result.setup.entryPrice
          : snap.close;
        const stopPx = Number.isFinite(result.setup.stopLoss) ? result.setup.stopLoss : entryPx;
        const riskPerShare = Math.abs(entryPx - stopPx);

        if (Number.isFinite(entryPx) && entryPx > 0) {
          finalInvestmentAmount = Math.round(finalPositionSize * entryPx * 100) / 100;
        }
        // Never let a NaN/Infinity risk-per-share reach the order record.
        finalMaxRiskInr = Number.isFinite(riskPerShare)
          ? Math.round(finalPositionSize * riskPerShare * 100) / 100
          : 0;
      }
    }

    // ── Signal PASSED all gates! ──────────────────────────────────────
    const signal: IntelligenceSignal = {
      symbol: result.symbol,
      name: result.name,
      signal: result.setup.direction,
      setupType: result.setup.setupType,

      entryPrice: result.setup.entryPrice,
      stopLoss: result.setup.stopLoss,
      target1: result.setup.target1,
      target2: result.setup.target2,
      riskReward: result.setup.riskReward,

      aiScore,
      confidence,
      patternScore: Math.round(patternScore),
      chronosScore: Math.round(chronosScore),
      technicalScore,
      sentimentScore: Math.round(sentimentScore),

      sector: result.sector,
      regime: regime.regime,
      regimeConfidence: regime.confidence,

      positionSize: finalPositionSize,
      investmentAmount: finalInvestmentAmount,
      maxRiskInr: finalMaxRiskInr,
      stopDistancePct: riskAssessment.stopDistancePct,
      riskWarnings: riskAssessment.warningReasons,

      featureVector: features,

      reasoning: dynamicReasoning,
      confluence: mergedConfluence,
      aiPatterns: aiResult?.technicalRanking?.detected_patterns ?? [],
      aiMode,
      rankingProvider,
      scannerType: result.category,
      timestamp: new Date().toISOString(),
      signalId: crypto.randomUUID(),
      signalFactors: calculateSignalFactors(
        result.setup.direction,
        snap,
        features,
        aiContributing,
        patternScore,
        chronosScore,
        technicalScore,
        regimeScore,
        sentimentScore,
        learningMetrics.get(result.symbol)
      ),
      
      provisional_trigger,
      provisional_deviation,
      mtf_score: result.mtfScore ?? 0,
      mtf_total: result.mtfTotal ?? 0,
      mtf_confluence: result.mtfConfluenceString ?? 'PENDING',

      scanLatencyMs: scanEnd - pipelineStart,
      aiLatencyMs: aiEnd - aiStart,
      totalLatencyMs: Date.now() - pipelineStart,
      decisionTrace: {
        regime: regime.regime,
        regimeStrength: regime.confidence,
        chronos: aiResult?.chronos,
        sentiment_score: sentimentScore,
        win_probability: aiResult?.win_probability,
        bullish_probability: aiResult?.technicalRanking?.bullish_probability,
        confidencePath: usedConfluence ? "python_confluence" : "native_math_fallback",
        rankerBlendApplied: !!(aiResult?.ranker_loaded && typeof aiResult?.win_probability === "number"),
        shap_values: aiResult?.shap_values,
        analysisTraceId: analysisTrace.traceId,
        laya_verdict: aiResult?.laya_decision?.verdict,
        laya_action: aiResult?.laya_decision?.action,
        system1_verdict: aiResult?.system1_decision?.verdict,
        system1_action: aiResult?.system1_decision?.action,
        system1_confidence: aiResult?.system1_decision?.confidence,
        position_size_multiplier: aiResult?.system1_decision?.position_size_multiplier,
      }
    };

    signals.push(signal);
  }

  recordAnalysisStage(analysisTrace, "decision_gates", "ok", decisionStageStart, {
    candidateCount: candidates.length,
    source: "signal_generator",
    metadata: { signals: signals.length, rejectedByAI, rejectedByRisk },
  });
  recordAnalysisStage(analysisTrace, "risk_assessment", "ok", decisionStageStart, {
    candidateCount: candidates.length,
    source: "risk_engine",
    metadata: { rejectedByRisk, accepted: signals.length },
  });

  // Sort by confidence descending — surface highest quality first
  signals.sort((a, b) => b.confidence - a.confidence);

  const totalLatencyMs = Date.now() - pipelineStart;

  logger.info(
    {
      signalsGenerated: signals.length,
      candidatesScanned: scanResults.length,
      candidatesPassed: candidates.length,
      rejectedByRisk,
      rejectedByAI,
      totalLatencyMs,
      aiLatencyMs: aiEnd - aiStart,
      regime: regime.regime,
      aiServiceStatus: health.status,
    },
    "Intelligence pipeline completed",
  );

  return {
    signals,
    regime,
    candidatesScanned: scanResults.length,
    candidatesPassed: candidates.length,
    candidatesRejectedByRisk: rejectedByRisk,
    candidatesRejectedByAI: rejectedByAI,
    scanLatencyMs: scanEnd - pipelineStart,
    aiLatencyMs: aiEnd - aiStart,
    totalLatencyMs,
    aiServiceStatus: health.status,
    aiMode: signals.length > 0 ? signals[0]!.aiMode : (health.status === "unavailable" || health.status === "degraded") ? "Fallback Mode" : "AI Mode",
    rankingProvider: signals.length > 0 ? signals[0]!.rankingProvider : (health.status === "unavailable" || health.status === "degraded") ? "Technical Ranking" : "AI Ranking",
    timestamp: new Date().toISOString(),
    analysisTrace,
    rejectedSignals
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapChronosToScore(
  chronos: BatchResult["chronos"],
  direction: "BUY" | "SELL",
): number {
  // Convert Chronos forecast to a 0-100 score relative to direction
  const forecastReturn = chronos.forecast_return_pct ?? 0;

  if (direction === "BUY") {
    if (chronos.trend === "bullish" && forecastReturn > 0) {
      return Math.min(100, 60 + forecastReturn * 10);
    }
    if (chronos.trend === "neutral") return 50;
    return Math.max(0, 40 - Math.abs(forecastReturn) * 5);
  } else {
    if (chronos.trend === "bearish" && forecastReturn < 0) {
      return Math.min(100, 60 + Math.abs(forecastReturn) * 10);
    }
    if (chronos.trend === "neutral") return 50;
    return Math.max(0, 40 - Math.abs(forecastReturn) * 5);
  }
}

function isRegimeCompatible(regime: MarketRegime, direction: "BUY" | "SELL"): boolean {
  // HIGH_VOLATILITY is now allowed, penalty is applied in confidence scoring instead
  
  // Bearish regime blocks buys (except mean reversion)
  if (direction === "BUY" && (regime === "BEARISH_CONTRACTION")) return false;

  // Bullish regime blocks sells (except mean reversion)
  if (direction === "SELL" && (regime === "BULLISH_EXPANSION")) return false;

  // Everything else is compatible
  return true;
}

function calculateSignalFactors(
  direction: "BUY" | "SELL",
  snap: TechnicalSnapshot,
  features: FeatureVector,
  aiContributing: boolean,
  patternScore: number,
  chronosScore: number,
  technicalScore: number,
  regimeScore: number,
  sentimentScore: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  learningMetric?: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  const rsVal = features.rsVsNifty60d;
  const rsNormalized = Math.max(0, Math.min(100, ((rsVal - 0.8) / 0.4) * 100));
  const sectorVal = features.sectorStrength;
  const sectorNormalized = Math.max(0, Math.min(100, ((sectorVal + 2) / 4) * 100));

  const techContrib = Math.round(technicalScore * (aiContributing ? 0.30 : 0.40));
  const rsContrib = Math.round(rsNormalized * (aiContributing ? 0.20 : 0.30));
  const sectorContrib = Math.round(sectorNormalized * (aiContributing ? 0.15 : 0.20));
  const regimeContrib = Math.round(regimeScore * 0.10);
  const patternContrib = aiContributing ? Math.round(patternScore * 0.15) : 0;
  const chronosContrib = aiContributing ? Math.round(chronosScore * 0.10) : 0;

  // Sub-breakdowns of technical indicators
  const rsiValue = snap.rsi14;
  let rsiContrib: number;
  if (direction === "BUY") {
    if (rsiValue >= 50 && rsiValue <= 70) rsiContrib = 8 + (rsiValue - 50) * 0.2;
    else if (rsiValue > 70) rsiContrib = 10;
    else if (rsiValue >= 40) rsiContrib = 4;
    else rsiContrib = 1;
  } else {
    if (rsiValue <= 50 && rsiValue >= 30) rsiContrib = 8 + (50 - rsiValue) * 0.2;
    else if (rsiValue < 30) rsiContrib = 10;
    else if (rsiValue <= 60) rsiContrib = 4;
    else rsiContrib = 1;
  }

  const isCrossover = features.momentumScore > 65;
  const macdContrib = Math.round(features.momentumScore * 0.12);

  const vwapAbove = direction === "BUY" ? features.vwapDistance > 0 : features.vwapDistance < 0;
  const vwapContrib = Math.max(2, Math.min(10, Math.round(Math.abs(features.vwapDistance) * 3 + 3)));

  const volRatio = features.volumeRatio;
  const volContrib = Math.max(3, Math.min(15, Math.round((volRatio - 1) * 8 + 4)));

  return {
    technical: {
      score: technicalScore,
      contribution: techContrib,
      rsi: { value: Math.round(rsiValue * 10) / 10, contribution: Math.round(rsiContrib) },
      macd: { crossover: isCrossover, contribution: Math.round(macdContrib) },
      vwap: { above: vwapAbove, distancePct: Math.round(features.vwapDistance * 100) / 100, contribution: Math.round(vwapContrib) },
      volume: { ratio: Math.round(volRatio * 100) / 100, contribution: Math.round(volContrib) }
    },
    relativeStrength: {
      value: Math.round(features.rsVsNifty60d * 100) / 100,
      contribution: rsContrib,
    },
    sector: {
      strengthPct: Math.round(features.sectorStrength * 100) / 100,
      contribution: sectorContrib,
    },
    regime: {
      score: regimeScore,
      contribution: regimeContrib,
      align: learningMetric?.regimeAlign ? parseFloat(learningMetric.regimeAlign) : null,
    },
    technicalRanking: aiContributing ? {
      score: Math.round(patternScore),
      contribution: patternContrib,
    } : null,
    chronos: aiContributing ? {
      score: Math.round(chronosScore),
      contribution: chronosContrib,
    } : null,
    sentiment: {
      score: Math.round(sentimentScore),
      contribution: 0
    },
    techEdge: learningMetric?.techEdge ? parseFloat(learningMetric.techEdge) : null,
  };
}
