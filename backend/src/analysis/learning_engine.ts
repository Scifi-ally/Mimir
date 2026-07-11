/**
 * Continuous Learning Engine — Layer 9
 * ─────────────────────────────────────────────────────────────────────────────
 * Analyzes past signal outcomes, computes performance metrics, and extracts
 * insights about sectors, regimes, and confidence ranges. Saves the results
 * in the learning_analytics table for UI terminal rendering.
 */
import { db } from "../../db/src";
import { suggestionsTable, learningAnalyticsTable, signalOutcomesTable, learningMetricsTable } from "../../db/src";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getLastRegimeOutput } from "./regime_detector";

export interface SectorMetric {
  sector: string;
  trades: number;
  winRate: number;
  pnl: number;
}

export interface RegimeMetric {
  regime: string;
  trades: number;
  winRate: number;
  pnl: number;
}

export interface ConfidenceMetric {
  range: string;
  trades: number;
  winRate: number;
  pnl: number;
}

/**
 * Runs the analysis pipeline on past suggestions
 */
export async function runLearningPipeline(): Promise<void> {
  logger.info("Starting continuous learning pipeline...");

  try {
    // 1. Fetch all closed suggestions
    const closed = await db
      .select({
        id: suggestionsTable.id,
        symbol: suggestionsTable.symbol,
        setupType: suggestionsTable.setupType,
        direction: suggestionsTable.direction,
        entryPrice: suggestionsTable.entryPrice,
        outcomePrice: suggestionsTable.outcomePrice,
        pnlInr: suggestionsTable.pnlInr,
        status: suggestionsTable.status,
        marketRegime: suggestionsTable.marketRegime,
        closedAt: suggestionsTable.closedAt,
        generatedAt: suggestionsTable.generatedAt,
        reasoning: suggestionsTable.reasoning,
      })
      .from(suggestionsTable)
      .where(sql`status IN ('TARGET_1_HIT', 'TARGET_2_HIT', 'STOP_HIT', 'EXPIRED')`);

    if (closed.length < 5) {
      logger.info(
        { count: closed.length },
        "Skipping learning pipeline — insufficient closed trades data",
      );
      return;
    }

    // Populate signal outcomes table if not already populated
    await syncSignalOutcomes(closed);

    // 2. Perform sector performance analysis
    await analyzeSectors(closed);

    // 3. Perform regime performance analysis
    await analyzeRegimes(closed);

    // 4. Perform confidence analysis
    await analyzeConfidence();

    // 5. Calculate and save adaptive AI weights
    await calculateAdaptiveWeights(closed);

    // 6. Generate high-level learning insights
    await generateGeneralInsights(closed);

    // 7. Auto-tune Risk Engine parameters based on recent performance
    await analyzeRiskAutotuning(closed);

    // 8. Analyze symbol-specific learning metrics (Tech Edge, Regime Align)
    await analyzeSymbolMetrics(closed);

    logger.info("Continuous learning pipeline completed successfully");
  } catch (err) {
    logger.error({ err }, "Error running learning pipeline");
  }
}

/**
 * Sync closed suggestion outcomes to the dedicated outcomes log
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncSignalOutcomes(closed: any[]): Promise<void> {
  for (const trade of closed) {
    // Check if already synced
    const [existing] = await db
      .select({ id: signalOutcomesTable.id })
      .from(signalOutcomesTable)
      .where(eq(signalOutcomesTable.suggestionId, trade.id))
      .limit(1);

    if (existing) continue;

    const pnl = trade.pnlInr ? parseFloat(trade.pnlInr) : 0;
    
    let duration = 0;
    if (trade.closedAt && trade.generatedAt) {
      duration = Math.round((trade.closedAt.getTime() - trade.generatedAt.getTime()) / (1000 * 60));
    }

    await db.insert(signalOutcomesTable).values({
      suggestionId: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      exitPrice: trade.outcomePrice || trade.entryPrice,
      pnl: pnl.toString(),
      durationMinutes: duration,
      status: trade.status,
      marketRegime: trade.marketRegime || "UNKNOWN",
      closedAt: trade.closedAt || new Date(),
    });
  }
}

/**
 * Maps stock symbols to sectors (reuse scanner sector mapping)
 */
import { STOCK_SECTOR_MAP } from "./stock_scanner";
function getSector(symbol: string): string {
  return STOCK_SECTOR_MAP[symbol] ?? "Other";
}

/**
 * Analyzes sector performance
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function analyzeSectors(closed: any[]): Promise<void> {
  const sectors: Record<string, { total: number; wins: number; pnl: number }> = {};

  for (const trade of closed) {
    const sector = getSector(trade.symbol);
    if (!sectors[sector]) {
      sectors[sector] = { total: 0, wins: 0, pnl: 0 };
    }
    const sec = sectors[sector]!;
    sec.total++;
    if (trade.status.includes("TARGET")) {
      sec.wins++;
    }
    sec.pnl += trade.pnlInr ? parseFloat(trade.pnlInr) : 0;
  }

  // Find best and worst sectors
  const sectorList = Object.entries(sectors).map(([name, data]) => ({
    name,
    trades: data.total,
    winRate: (data.wins / data.total) * 100,
    pnl: Math.round(data.pnl),
  }));

  sectorList.sort((a, b) => b.pnl - a.pnl);

  // Clear existing sector records and update
  await db.delete(learningAnalyticsTable).where(eq(learningAnalyticsTable.tag, "BEST_SECTOR"));

  for (let i = 0; i < Math.min(sectorList.length, 5); i++) {
    const s = sectorList[i]!;
    if (s.pnl > 0) {
      await db.insert(learningAnalyticsTable).values({
        tag: "BEST_SECTOR",
        metricName: s.name,
        metricValue: s.winRate.toFixed(2),
        insights: `Rank #${i + 1} best sector: ₹${s.pnl} profit over ${s.trades} trades. Win rate: ${s.winRate.toFixed(1)}%.`,
      });
    }
  }
}

/**
 * Analyzes market regime performance
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function analyzeRegimes(closed: any[]): Promise<void> {
  const regimes: Record<string, { total: number; wins: number; pnl: number }> = {};

  for (const trade of closed) {
    const regime = trade.marketRegime || "UNKNOWN";
    if (!regimes[regime]) {
      regimes[regime] = { total: 0, wins: 0, pnl: 0 };
    }
    const reg = regimes[regime]!;
    reg.total++;
    if (trade.status.includes("TARGET")) {
      reg.wins++;
    }
    reg.pnl += trade.pnlInr ? parseFloat(trade.pnlInr) : 0;
  }

  const regimeList = Object.entries(regimes).map(([name, data]) => ({
    name,
    trades: data.total,
    winRate: (data.wins / data.total) * 100,
    pnl: Math.round(data.pnl),
  }));

  await db.delete(learningAnalyticsTable).where(eq(learningAnalyticsTable.tag, "BEST_REGIME"));

  regimeList.sort((a, b) => b.pnl - a.pnl);

  for (let i = 0; i < Math.min(regimeList.length, 3); i++) {
    const r = regimeList[i]!;
    await db.insert(learningAnalyticsTable).values({
      tag: "BEST_REGIME",
      metricName: r.name,
      metricValue: r.winRate.toFixed(2),
      insights: `Regime ${r.name} performance: ₹${r.pnl} profit over ${r.trades} trades. Win rate: ${r.winRate.toFixed(1)}%.`,
    });
  }
}

/**
 * Analyzes AI score / confidence performance ranges
 */
async function analyzeConfidence(): Promise<void> {
  // Query suggestions along with their confidence
  const results = await db
    .select({
      id: suggestionsTable.id,
      status: suggestionsTable.status,
      pnlInr: suggestionsTable.pnlInr,
      reasoning: suggestionsTable.reasoning,
    })
    .from(suggestionsTable)
    .where(sql`status IN ('TARGET_1_HIT', 'TARGET_2_HIT', 'STOP_HIT', 'EXPIRED')`);

  const confidenceRanges: Record<string, { total: number; wins: number; pnl: number }> = {
    "90-100 (Elite)": { total: 0, wins: 0, pnl: 0 },
    "80-89 (High)": { total: 0, wins: 0, pnl: 0 },
    "70-79 (Moderate)": { total: 0, wins: 0, pnl: 0 },
    "Below 70 (Low)": { total: 0, wins: 0, pnl: 0 },
  };

  for (const trade of results) {
    // Extract confidence from reasoning string, e.g. [CF:82.4|...]
    const match = trade.reasoning?.match(/CF:([0-9.]+)/);
    if (!match) continue;

    const cf = parseFloat(match[1]!);
    let range = "Below 70 (Low)";
    if (cf >= 90) range = "90-100 (Elite)";
    else if (cf >= 80) range = "80-89 (High)";
    else if (cf >= 70) range = "70-79 (Moderate)";

    const r = confidenceRanges[range]!;
    r.total++;
    if (trade.status.includes("TARGET")) r.wins++;
    r.pnl += trade.pnlInr ? parseFloat(trade.pnlInr) : 0;
  }

  const confList = Object.entries(confidenceRanges).map(([name, data]) => ({
    name,
    trades: data.total,
    winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
    pnl: Math.round(data.pnl),
  }));

  await db.delete(learningAnalyticsTable).where(eq(learningAnalyticsTable.tag, "CONFIDENCE_ACCURACY"));

  for (const c of confList) {
    if (c.trades > 0) {
      await db.insert(learningAnalyticsTable).values({
        tag: "CONFIDENCE_ACCURACY",
        metricName: c.name,
        metricValue: c.winRate.toFixed(2),
        insights: `Accuracy for ${c.name} suggestions: ${c.winRate.toFixed(1)}% win rate across ${c.trades} trades.`,
      });
    }
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

/**
 * Dynamically computes optimal component weights based on historical win rates of individual features.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function calculateAdaptiveWeights(closed: any[]): Promise<void> {
  const defaultWeights = { tech: 0.30, technicalRanking: 0.15, chronos: 0.10, rs: 0.20, sector: 0.15, regime: 0.10 };
  
  if (closed.length < 10) return;

  let techWins = 0, techTotal = 0;
  let patternWins = 0, patternTotal = 0;
  let chronosWins = 0, chronosTotal = 0;

  for (const trade of closed) {
    const isWin = trade.status.includes("TARGET");
    const reasoning = trade.reasoning || "";
    
    const techMatch = reasoning.match(/T:([0-9]+)/);
    const technicalRankingMatch = reasoning.match(/K:([0-9]+)/);
    const chronosMatch = reasoning.match(/C:([0-9]+)/);

    if (techMatch && parseInt(techMatch[1]!) > 70) {
      techTotal++;
      if (isWin) techWins++;
    }
    if (technicalRankingMatch && parseInt(technicalRankingMatch[1]!) > 70) {
      patternTotal++;
      if (isWin) patternWins++;
    }
    if (chronosMatch && parseInt(chronosMatch[1]!) > 70) {
      chronosTotal++;
      if (isWin) chronosWins++;
    }
  }

  const techPower = techTotal > 5 ? techWins / techTotal : 0.5;
  const patternPower = patternTotal > 5 ? patternWins / patternTotal : 0.5;
  const chronosPower = chronosTotal > 5 ? chronosWins / chronosTotal : 0.5;

  const techShift = clamp((techPower - 0.5) * 0.15, -0.08, 0.08);
  const patternShift = clamp((patternPower - 0.5) * 0.15, -0.08, 0.08);
  const chronosShift = clamp((chronosPower - 0.5) * 0.15, -0.08, 0.08);

  const newWeights = {
    tech: clamp(defaultWeights.tech + techShift, 0.20, 0.40),
    technicalRanking: clamp(defaultWeights.technicalRanking + patternShift, 0.05, 0.25),
    chronos: clamp(defaultWeights.chronos + chronosShift, 0.05, 0.20),
    rs: defaultWeights.rs,
    sector: defaultWeights.sector,
    regime: defaultWeights.regime,
  };

  const sum = newWeights.tech + newWeights.technicalRanking + newWeights.chronos + newWeights.rs + newWeights.sector + newWeights.regime;
  
  const normalizedWeights = {
    tech: newWeights.tech / sum,
    technicalRanking: newWeights.technicalRanking / sum,
    chronos: newWeights.chronos / sum,
    rs: newWeights.rs / sum,
    sector: newWeights.sector / sum,
    regime: newWeights.regime / sum,
  };

  await db.delete(learningAnalyticsTable).where(eq(learningAnalyticsTable.tag, "ADAPTIVE_WEIGHTS"));
  
  await db.insert(learningAnalyticsTable).values({
    tag: "ADAPTIVE_WEIGHTS",
    metricName: "Confidence Feature Weights",
    metricValue: "1.0",
    insights: JSON.stringify(normalizedWeights),
  });

  logger.info({ weights: normalizedWeights }, "Calculated and saved new adaptive weights");
}

/**
 * High-level NLP insights generation
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateGeneralInsights(closed: any[]): Promise<void> {
  const total = closed.length;
  const wins = closed.filter(t => t.status.includes("TARGET")).length;
  const winRate = (wins / total) * 100;

  const totalPnl = closed.reduce((acc, t) => acc + (t.pnlInr ? parseFloat(t.pnlInr) : 0), 0);

  await db.delete(learningAnalyticsTable).where(eq(learningAnalyticsTable.tag, "LEARNING_SUMMARY"));

  await db.insert(learningAnalyticsTable).values({
    tag: "LEARNING_SUMMARY",
    metricName: "Platform Win Rate",
    metricValue: winRate.toFixed(2),
    insights: `Continuous engine monitoring ${total} trades. Total platform profitability: ₹${Math.round(totalPnl)}. Win rate: ${winRate.toFixed(1)}%.`,
  });
}

/**
 * Evaluates the last 20 trades and automatically tunes risk parameters.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function analyzeRiskAutotuning(closed: any[]): Promise<void> {
  const recent = closed.sort((a, b) => (b.closedAt?.getTime() || 0) - (a.closedAt?.getTime() || 0)).slice(0, 20);
  if (recent.length < 10) return;

  const wins = recent.filter(t => t.status.includes("TARGET")).length;
  const winRate = wins / recent.length;

  let mode = "DEFAULT";
  let maxRiskPerTradePct = 1.0;
  let minRiskReward = 1.5;

  if (winRate < 0.35) {
    mode = "CAPITAL_PRESERVATION";
    maxRiskPerTradePct = 0.5; // Halve risk per trade
    minRiskReward = 2.5;      // Require stricter setups
  } else if (winRate > 0.65) {
    mode = "AGGRESSIVE";
    maxRiskPerTradePct = 1.5; // Slightly increase risk per trade
    minRiskReward = 1.2;      // Accept lower RR setups
  }

  const payload = { mode, maxRiskPerTradePct, minRiskReward, winRate };

  await db.delete(learningAnalyticsTable).where(eq(learningAnalyticsTable.tag, "AUTO_TUNE_RISK"));
  await db.insert(learningAnalyticsTable).values({
    tag: "AUTO_TUNE_RISK",
    metricName: "Risk Mode",
    metricValue: mode,
    insights: JSON.stringify(payload),
  });

  logger.info({ mode, winRate }, "Auto-Tuned Risk Engine updated");
}

export interface AutoTunedRiskParams {
  mode: "DEFAULT" | "CAPITAL_PRESERVATION" | "AGGRESSIVE";
  maxRiskPerTradePct: number;
  minRiskReward: number;
}

let riskParamsCache: AutoTunedRiskParams | null = null;
let lastRiskParamsFetch = 0;

export async function getAutoTunedRiskParams(): Promise<AutoTunedRiskParams> {
  const defaults: AutoTunedRiskParams = { mode: "DEFAULT", maxRiskPerTradePct: 1.0, minRiskReward: 1.5 };
  
  if (riskParamsCache && Date.now() - lastRiskParamsFetch < 5 * 60 * 1000) {
    return riskParamsCache;
  }

  try {
    const [row] = await db
      .select({ insights: learningAnalyticsTable.insights })
      .from(learningAnalyticsTable)
      .where(eq(learningAnalyticsTable.tag, "AUTO_TUNE_RISK"))
      .limit(1);

    if (row && row.insights) {
      riskParamsCache = JSON.parse(row.insights);
      lastRiskParamsFetch = Date.now();
      return riskParamsCache!;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch auto-tuned risk params, using defaults");
  }

  return defaults;
}

/**
 * Task 4: Evaluates past signals to compute tech_edge and regime_align per symbol
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function analyzeSymbolMetrics(closed: any[]): Promise<void> {
  const currentRegimeState = getLastRegimeOutput();
  const currentRegime = currentRegimeState?.regime ?? "UNKNOWN";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const symbolGroups: Record<string, any[]> = {};
  for (const trade of closed) {
    if (!symbolGroups[trade.symbol]) {
      symbolGroups[trade.symbol] = [];
    }
    symbolGroups[trade.symbol].push(trade);
  }

  for (const [symbol, trades] of Object.entries(symbolGroups)) {
    // Tech Edge Calculation
    // "percentage of past signals for this symbol where the technical setup (RSI + EMA cross + volume) preceded a profitable move within 5 candles"
    const techSignals = trades.filter(t => 
      t.reasoning?.includes("RSI") || 
      t.reasoning?.includes("EMA") || 
      t.reasoning?.includes("vol") || 
      t.reasoning?.includes("technical")
    );

    let techEdge: number | null;
    if (techSignals.length >= 10) {
      const profitable = techSignals.filter(t => t.status.includes("TARGET")).length;
      techEdge = (profitable / techSignals.length) * 100;
    } else {
      techEdge = 50.0; // Baseline for learning phase
    }

    // Regime Align Calculation
    // "percentage of past trades taken in the current regime that were profitable for this symbol"
    let regimeAlign: number | null;
    const regimeTrades = trades.filter(t => t.marketRegime === currentRegime);
    if (regimeTrades.length >= 10) {
      const profitable = regimeTrades.filter(t => t.status.includes("TARGET")).length;
      regimeAlign = (profitable / regimeTrades.length) * 100;
    } else {
      regimeAlign = 50.0; // Baseline for learning phase
    }

    // Upsert into learning_metrics table
    const id = `${symbol}_${currentRegime}`;
    await db.insert(learningMetricsTable).values({
      id,
      symbol,
      techEdge: techEdge !== null ? techEdge.toFixed(2) : null,
      regimeAlign: regimeAlign !== null ? regimeAlign.toFixed(2) : null,
      regimeLabel: currentRegime,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [learningMetricsTable.symbol, learningMetricsTable.regimeLabel],
      set: {
        techEdge: techEdge !== null ? techEdge.toFixed(2) : null,
        regimeAlign: regimeAlign !== null ? regimeAlign.toFixed(2) : null,
        updatedAt: new Date(),
      }
    });
  }
}
