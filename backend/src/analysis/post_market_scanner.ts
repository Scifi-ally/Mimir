/**
 * Post-Market Full NSE Scanner
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs comprehensive analysis after market close on the full NSE universe.
 * Takes time to properly scan each stock without rushing.
 *
 * Features:
 * - Analyzes every stock with multi-timeframe confluence
 * - Tracks setup formation and signal confidence
 * - Ranks by probability and filters strictly
 * - Saves results for next day's monitoring
 * - Provides detailed diagnostics on blockers
 */

import { logger } from "../lib/logger";
import { db } from "../../db/src";
import { overnightWatchlistTable } from "../../db/src";
import { eq } from "drizzle-orm";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { getTargetTradingSessionDate } from "../market_data/market_state";
import { getEffectiveUniverse } from "./stock_scanner";
import { analyzeMultiTimeframe } from "./multi_timeframe";
import { beginWorkflow, endWorkflow } from "../workflow/coordinator";

interface PostMarketScanResult {
  symbol: string;
  name: string;
  sector: string;
  direction: "BUY" | "SELL";
  setupType: string;
  confluenceScore: number;
  signalStrength: number;
  dailyTrend: string;
  hourlyTrend: string;
  reasoning: string;
  probability: number;
  category: string;
}

interface ScannerState {
  running: boolean;
  lastStatus: "idle" | "running" | "success" | "failed" | "stopped";
  lastMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  totalStocks: number;
  analyzedCount: number;
  candidatesFound: number;
  errors: number;
  diagnostics: {
    noData: number;
    noSetup: number;
    lowConfluence: number;
    bearishRegime: number;
    corporateAction: number;
    sectorConcern: number;
  };
  topCandidates: PostMarketScanResult[];
}

let scannerState: ScannerState = {
  running: false,
  lastStatus: "idle",
  lastMessage: null,
  startedAt: null,
  finishedAt: null,
  totalStocks: 0,
  analyzedCount: 0,
  candidatesFound: 0,
  errors: 0,
  diagnostics: {
    noData: 0,
    noSetup: 0,
    lowConfluence: 0,
    bearishRegime: 0,
    corporateAction: 0,
    sectorConcern: 0,
  },
  topCandidates: [],
};
let abortRequested = false;

/**
 * Run comprehensive post-market scan on full NSE universe
 */
export async function runPostMarketFullScan(
  source: "scheduler" | "manual" | "startup" = "scheduler",
): Promise<PostMarketScanResult[]> {
  if (scannerState.running) {
    logger.warn("Post-market scan already running");
    return [];
  }

  const workflow = beginWorkflow("POSTMARKET_SCAN", source);
  if (!workflow.ok) {
    logger.warn(
      { reason: workflow.reason },
      "Post-market scan skipped due to workflow conflict",
    );
    return [];
  }

  const startTime = Date.now();
  let workflowSuccess = true;
  let workflowFailureReason: string | undefined;
  scannerState = {
    running: true,
    lastStatus: "running",
    lastMessage: "Preparing post-market scan",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalStocks: 0,
    analyzedCount: 0,
    candidatesFound: 0,
    errors: 0,
    diagnostics: {
      noData: 0,
      noSetup: 0,
      lowConfluence: 0,
      bearishRegime: 0,
      corporateAction: 0,
      sectorConcern: 0,
    },
    topCandidates: [],
  };
  abortRequested = false;

  try {
    const universe = await getEffectiveUniverse();
    scannerState.totalStocks = universe.length;
    scannerState.lastMessage = `Analyzing ${universe.length} NSE stocks`;

    logger.info(
      { stockCount: universe.length },
      "Starting post-market full NSE scan",
    );

    broadcast(createServerEvent.scanStarted({
      stocksToAnalyze: universe.length,
      timestamp: new Date().toISOString(),
    }));

    const candidates: PostMarketScanResult[] = [];
    const batchSize = 5; // Analyze in small batches to avoid overwhelming API
    const delayBetweenBatches = 1000; // 1 second between batches

  // Process stocks in batches
    for (let i = 0; i < universe.length; i += batchSize) {
      if (abortRequested) {
        workflowSuccess = false;
        workflowFailureReason = "Post-market scan stopped by user";
        scannerState.running = false;
        scannerState.lastStatus = "stopped";
        scannerState.lastMessage = "Post-market scan stopped by user";
        scannerState.finishedAt = new Date().toISOString();
        broadcast(createServerEvent.scanCompleted({
          suggestionsGenerated: 0,
          duration: Date.now() - startTime,
          outcome: "STOPPED",
          message: scannerState.lastMessage,
        }));
        return [];
      }
      const batch = universe.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((stock) => analyzeStockForPostMarketScan(stock)),
    );

    for (const result of batchResults) {
      scannerState.analyzedCount++;

      if (result) {
        candidates.push(result);
        scannerState.candidatesFound++;
      }

      // Broadcast progress every 10 stocks
      if (scannerState.analyzedCount % 10 === 0) {
        broadcast(
          createServerEvent.scanProgress({
            current: scannerState.analyzedCount,
            total: universe.length,
            currentStock: result?.symbol ?? "scanning",
          }),
        );

        logger.info(
          {
            analyzed: scannerState.analyzedCount,
            total: universe.length,
            candidatesFound: scannerState.candidatesFound,
          },
          "Post-market scan progress",
        );
      }
    }

    // Delay between batches
      if (i + batchSize < universe.length) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
      }
    }

    if (abortRequested) {
      workflowSuccess = false;
      workflowFailureReason = "Post-market scan stopped by user";
      scannerState.running = false;
      scannerState.lastStatus = "stopped";
      scannerState.lastMessage = workflowFailureReason;
      scannerState.finishedAt = new Date().toISOString();
      broadcast(createServerEvent.scanCompleted({
        suggestionsGenerated: 0,
        duration: Date.now() - startTime,
        outcome: "STOPPED",
        message: scannerState.lastMessage,
      }));
      return [];
    }

  // Rank candidates by probability
    const ranked = candidates
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 30); // Keep top 30 for monitoring

    scannerState.topCandidates = ranked.slice(0, 10);
    scannerState.finishedAt = new Date().toISOString();
    scannerState.running = false;
    scannerState.lastStatus = "success";
    scannerState.lastMessage = `Found ${ranked.length} candidates`;

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        candidatesFound: ranked.length,
        duration: `${(durationMs / 1000).toFixed(2)}s`,
        topPicks: ranked
          .slice(0, 5)
          .map((c) => `${c.symbol}(${c.probability.toFixed(0)}%)`),
      },
      "Post-market scan completed",
    );

    // Persist before announcing completion. The client refetches the watchlist
    // on this event, so emitting earlier creates a stale-data race.
    const targetTradingDay = getTargetTradingSessionDate();
    await saveWatchlistCandidates(ranked, targetTradingDay);

    broadcast(
      createServerEvent.scanCompleted({
        suggestionsGenerated: ranked.length,
        duration: durationMs,
        outcome: "COMPLETED",
        message: scannerState.lastMessage,
      }),
    );

    return ranked;
  } catch (err) {
    workflowSuccess = false;
    workflowFailureReason =
      err instanceof Error ? err.message : "post-market scan failed";
    scannerState.running = false;
    scannerState.finishedAt = new Date().toISOString();
    scannerState.lastStatus = "failed";
    scannerState.lastMessage = workflowFailureReason;
    logger.error({ err }, "Post-market scan failed");
    broadcast(
      createServerEvent.scanCompleted({
        suggestionsGenerated: 0,
        duration: Date.now() - startTime,
        outcome: "FAILED",
        message: scannerState.lastMessage,
      }),
    );
    return [];
  } finally {
    endWorkflow("POSTMARKET_SCAN", workflowSuccess, workflowFailureReason, workflow.runToken);
  }
}

export function abortPostMarketFullScan(): boolean {
  if (!scannerState.running) return false;
  logger.warn("Manual abort requested for post-market scanner");
  abortRequested = true;
  scannerState.lastMessage = "Stopping post-market scan...";
  scannerState.lastStatus = "stopped";
  broadcast(
    createServerEvent.systemAlert({
      message: "Post-market scan manually stopped",
      severity: "warning",
    })
  );
  // Send zero progress to clear scan state
  broadcast(
    createServerEvent.scanProgress({
      total: 0, 
      current: 0,
      status: "STOPPED",
      currentStock: "",
      reason: ""
    })
  );
  return true;
}

/**
 * Analyze a single stock for post-market potential
 */
async function analyzeStockForPostMarketScan(
  stock: { symbol: string; key: string; name: string; sector: string },
): Promise<PostMarketScanResult | null> {
  try {
    const mtf = await analyzeMultiTimeframe(stock.key);

    // Check if signal exists
    if (!mtf.signal || mtf.signal.direction === "NEUTRAL") {
      scannerState.diagnostics.noSetup++;
      return null;
    }

    // Calculate probability based on confluence and directional agreement.
    let probability = mtf.signal.confluenceScore;

    if (mtf.signal.hourlyConfirm) probability += 5;
    if (mtf.signal.crossover1h) probability += 3;
    if (mtf.signal.crossover4h) probability += 5;
    if (mtf.signal.volumeIncrease) probability += 2;

    if (mtf.signal.direction === "BUY" && mtf.signal.dailyTrend === "UP") probability += 4;
    if (mtf.signal.direction === "SELL" && mtf.signal.dailyTrend === "DOWN") probability += 4;

    // Penalize weak confluence
    if (probability < 45) {
      scannerState.diagnostics.lowConfluence++;
      return null;
    }

    // Cap at 100%
    probability = Math.min(100, probability);

    // Determine setup type from the multi-timeframe direction state.
    let setupType = "EMA_ALIGNMENT";
    if (mtf.signal.hourlyConfirm && mtf.signal.crossover4h) setupType = "CROSSOVER";
    else if (mtf.signal.hourlyConfirm) setupType = "CONFIRMED_TREND";

    const reasoning = `${mtf.signal.dailyTrend} daily | ${mtf.signal.hourlyConfirm ? "Confirmed" : "Forming"} on hourly | Confluence: ${mtf.signal.confluenceScore}%`;

    return {
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      direction: mtf.signal.direction,
      setupType,
      confluenceScore: mtf.signal.confluenceScore,
      signalStrength: Math.min(100, probability),
      dailyTrend: mtf.signal.dailyTrend,
      hourlyTrend: mtf.signal.hourlyConfirm ? "CONFIRMED" : "FORMING",
      reasoning,
      probability,
      category: mtf.signal.direction === "BUY" ? "LONG_SETUP" : "SHORT_SETUP",
    };
  } catch (err) {
    scannerState.errors++;
    logger.debug(
      { err, symbol: stock.symbol },
      "Failed to analyze stock in post-market scan",
    );
    return null;
  }
}

/**
 * Save candidates to overnight watchlist for monitoring
 */
async function saveWatchlistCandidates(
  candidates: PostMarketScanResult[],
  forDate: string,
): Promise<void> {
  if (!candidates.length) {
    logger.info("No candidates to save to watchlist");
    return;
  }

  try {
    // Delete existing candidates for this date
    await db
      .delete(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, forDate));

    // Insert new candidates
    const rows = candidates.map((c) => {
      let condition = c.reasoning.replace(/₹/g, 'Rs.').replace(/…/g, '...');
      condition = condition.replace(/[^\x00-\x7F]/g, '');
      const maxLength = 250;
      if (condition.length > maxLength && !(condition.startsWith('{') && condition.endsWith('}'))) {
        condition = `${condition.slice(0, maxLength - 3).trimEnd()}...`;
      }
      
      return {
        forDate,
        symbol: c.symbol,
        name: c.name ? c.name.substring(0, 95) : "",
        category: c.category ? c.category.substring(0, 29) : "",
        condition,
        priority: Math.round(c.probability),
      };
    });

    await db.insert(overnightWatchlistTable).values(rows);

    logger.info(
      { candidatesCount: rows.length, forDate },
      "Watchlist candidates saved",
    );
  } catch (err) {
    logger.error({ err }, "Failed to save watchlist candidates");
    throw err;
  }
}

/**
 * Get current scanner state and diagnostics
 */
export function getScannerState() {
  return {
    ...scannerState,
    blockers: {
      "No Data/Setup": scannerState.diagnostics.noSetup,
      "Low Confluence": scannerState.diagnostics.lowConfluence,
      "No Data": scannerState.diagnostics.noData,
      "Bearish Regime": scannerState.diagnostics.bearishRegime,
      "Corporate Action": scannerState.diagnostics.corporateAction,
      "Sector Concern": scannerState.diagnostics.sectorConcern,
    },
  };
}
