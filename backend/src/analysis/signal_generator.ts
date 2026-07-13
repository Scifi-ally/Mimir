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
import { checkAIHealth, batchInference, type BatchResult } from "./ai_client";
import { checkEarningsRisk } from "./earnings_filter";
import { db, learningAnalyticsTable, symbolScoresTable, learningMetricsTable } from "../../db/src";
import { eq } from "drizzle-orm";
import { getISTDateStr } from "../lib/ist-time";

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
      adaptiveWeightsCache = { ...defaultWeights, ...JSON.parse(row.insights) };
      lastWeightFetch = Date.now();
      return adaptiveWeightsCache!;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch adaptive weights, using defaults");
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
}

export interface PipelineResult {
  signals: IntelligenceSignal[];
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
  const cfg = getConfig();
  
  const adaptiveWeights = await getAdaptiveWeights();

  // ── Step 0: Sync risk engine state with the database (Single Source of Truth) ──
  await syncRiskEngineState();

  // ── Step 1: Update market regime ──────────────────────────────────────
  detectRegime();
  const regime = getLastRegimeOutput()!;
  const activation = getScannerActivation();

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

  for (const result of activatedResults) {
    const candles = result.candles ?? candleCache?.get(result.symbol);
    const snap = result.snapshot ?? snapshotCache?.get(result.symbol);
    if (!candles || !snap) continue;

    // Calculate dynamic proxy for sector RS (Stock RS vs Nifty) / (Sector Avg RS vs Nifty)
    let rsVsSectorProxy = result.rs60;
    const sectorStats = result.sector ? sectorRsSums.get(result.sector) : null;
    if (sectorStats && sectorStats.count > 0) {
      const sectorAvgRs = sectorStats.total / sectorStats.count;
      // If the sector average is valid, the proxy is the ratio of stock's RS to its sector's RS
      rsVsSectorProxy = sectorAvgRs > 0 ? result.rs60 / sectorAvgRs : result.rs60;
    }

    const features = computeFeatureVector(
      result.symbol,
      result.sector,
      candles,
      snap,
      result.rs60,
      rsVsSectorProxy,
      result.setup.riskReward,
    );

    candidates.push({ result, features, candles, snap });
  }

  // ── Step 4: AI Intelligence Layer ─────────────────────────────────────
  const aiStart = Date.now();
  let aiResults = new Map<string, BatchResult>();

  const health = await checkAIHealth();

  if (health.status !== "unavailable" && candidates.length > 0) {
    aiResults = await batchInference(
      candidates.map(c => ({
        symbol: c.result.symbol,
        ohlcv: c.candles.map((candle) => [
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
        ]),
        features: c.features,
      })),
    );
    logger.info(
      { candidateCount: candidates.length, aiStatus: health.status },
      "AI batch inference completed",
    );
  } else if (candidates.length > 0) {
    logger.warn("AI service unavailable — using fallback confidence scoring");
  }

  const aiEnd = Date.now();

  // ── Step 5: Confidence scoring + Risk assessment + Signal generation ──
  const signals: IntelligenceSignal[] = [];
  let rejectedByRisk = 0;
  let rejectedByAI = 0;

  for (const candidate of candidates) {
    const { result, features, snap } = candidate;
    const aiResult = aiResults.get(result.symbol);
    const aiContributing =
      aiResult !== undefined &&
      !aiResult.isFallback &&
      (aiResult.technicalRanking.source === "model" || aiResult.chronos.source === "model");
      
    // Extract Sentiment
    const sentimentScore = aiResult?.sentiment_score ?? 50;

    const rankingProvider = aiContributing ? "AI Ranking" : "Technical Ranking";
    const aiMode = aiContributing ? "AI Mode" : "Fallback Mode";

    // Compute scores
    const technicalScore = Math.round(Math.min(100, (result.score / 10) * 100));
    const patternScore = aiResult?.technicalRanking.bullish_probability ?? 0;
    const chronosScore = aiResult
      ? mapChronosToScore(aiResult.chronos, result.setup.direction)
      : 0;

    // Sector strength from features
    const sectorStrength = features.sectorStrength;
    const regimeScore = features.regimeScore;

    // Compute final confidence
    let confidence = aiContributing
      ? computeFinalConfidence(
          technicalScore,
          patternScore,
          chronosScore,
          features.rsVsNifty60d,
          sectorStrength,
          regimeScore,
          sentimentScore,
          adaptiveWeights
        )
      : computeFallbackConfidence(
          technicalScore,
          features.rsVsNifty60d,
          sectorStrength,
          regimeScore,
          adaptiveWeights
        );

    // Apply high volatility penalty instead of hard blocking trades
    if (regime.regime === "HIGH_VOLATILITY") {
      confidence = Math.max(0, confidence - 15);
    }

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

    const dynamicReasoning = aiContributing
      ? `[LEARNING ENABLED] Reasons: Relative Strength +${rsCont.toFixed(1)}, Sector Rank +${sectorCont.toFixed(1)}, Volume Expansion +${features.volumeRatio ? ((features.volumeRatio - 1) * 100).toFixed(0) : "0"}%, Nifty50GPT Pattern Score +${patternCont.toFixed(1)}, Chronos Forecast Score +${chronosCont.toFixed(1)}, Total Composite Score ${confidence}. Contributions: Tech Quality +${techCont.toFixed(1)}, RS +${rsCont.toFixed(1)}, Sector +${sectorCont.toFixed(1)}, Nifty50GPT +${patternCont.toFixed(1)}, Chronos +${chronosCont.toFixed(1)}, Regime +${regimeCont.toFixed(1)}.`
      : `[LEARNING ENABLED] Reasons: Relative Strength +${rsCont.toFixed(1)}, Sector Rank +${sectorCont.toFixed(1)}, Volume Expansion +${features.volumeRatio ? ((features.volumeRatio - 1) * 100).toFixed(0) : "0"}%, Technical Score ${technicalScore}, Total Composite Score ${confidence}. Contributions: Tech Quality +${techCont.toFixed(1)}, RS +${rsCont.toFixed(1)}, Sector +${sectorCont.toFixed(1)}, Regime +${regimeCont.toFixed(1)}.`;

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
        logger.debug({ symbol: result.symbol }, "Signal rejected — Weekly trend is DOWN (MTF Filter)");
        continue;
      }
      if (!result.hourlyConfirmed && !isReversalOrPullback) {
        rejectedByAI++;
        logger.debug({ symbol: result.symbol }, "Signal rejected — Hourly trend does not confirm BUY (MTF Filter)");
        continue;
      }
    }
    
    if (result.setup.direction === "SELL") {
      if (result.mtfWeeklyTrend === "UP" && !isReversalOrPullback) {
        rejectedByAI++;
        logger.debug({ symbol: result.symbol }, "Signal rejected — Weekly trend is UP (MTF Filter)");
        continue;
      }
      if (!result.hourlyConfirmed && !isReversalOrPullback) {
        rejectedByAI++;
        logger.debug({ symbol: result.symbol }, "Signal rejected — Hourly trend does not confirm SELL (MTF Filter)");
        continue;
      }
    }

    // ── Regime direction check ────────────────────────────────────────
    if (!isRegimeCompatible(regime.regime, result.setup.direction)) {
      rejectedByAI++;
      logger.debug(
        { symbol: result.symbol, regime: regime.regime, direction: result.setup.direction },
        "Signal rejected — regime incompatible with direction",
      );
      continue;
    }

    // ── Risk assessment ───────────────────────────────────────────────
    const riskAssessment = await assessRisk(result.setup, snap, result.sector, features);

    if (!riskAssessment.passed) {
      rejectedByRisk++;
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

      positionSize: riskAssessment.positionSize,
      investmentAmount: riskAssessment.investmentAmount,
      maxRiskInr: riskAssessment.maxRiskInr,
      stopDistancePct: riskAssessment.stopDistancePct,
      riskWarnings: riskAssessment.warningReasons,

      featureVector: features,

      reasoning: dynamicReasoning,
      confluence: result.setup.confluence,
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
    };

    signals.push(signal);
  }

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
