/**
 * Suggestion Generator
 * ─────────────────────────────────────────────────────────────────────────────
 * Converts today's overnight-watchlist candidates into live suggestion records
 * by re-running technical analysis for fresh entry/stop/target levels,
 * then enforces all risk gates before inserting into the DB.
 */
import { db } from "../../db/src";
import { suggestionsTable, overnightWatchlistTable } from "../../db/src";
import { eq, and, desc, gte, or } from "drizzle-orm";
import { getAccessToken } from "../upstox/auth";
import { getConfig } from "../config";
import { getMarketState } from "../market_data/market_state";
import {
  STOCK_SECTOR_MAP,
  fetchNiftyDailyCandles,
  scanStock,
  diagnoseScanNullReason,
  getEffectiveUniverse,
  findStockBySymbol,
  ScanResult,
} from "../analysis/stock_scanner";
import { runIntelligencePipeline } from "../analysis/signal_generator";
import { checkSuggestionOutcomes } from "./accuracy_tracker";
import { fetchCorporateActionBlacklist } from "../market_data/corporate_actions";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { logger } from "../lib/logger";
import { intelligenceBus } from "../intelligence/event_bus";
import { createUpstoxClient } from "../lib/upstox-client";
import { getISTDateStr, getNextTradingDayStr } from "../lib/ist-time";
import { beginWorkflow, endWorkflow } from "../workflow/coordinator";

// ── Create optimized API client (reused across calls) ────────────────────────

const upstoxClient = createUpstoxClient({ cacheTimeMs: 20 * 1000 });
let generationInProgress = false;

const PER_CANDIDATE_TIMEOUT_MS = 45_000;
const SCAN_CONCURRENCY = 4; // reduced from 6 to minimize memory spikes
const MIN_GENERATION_GAP_MS = 90_000;
const CANDIDATE_OVERSAMPLE_FACTOR = 4;
let consecutiveZeroGenerationCycles = 0;
let lastGenerationStartedAtMs = 0;
let totalGenerationDurationMs = 0;

function normalizeSymbol(symbol: string): string {
  const raw = symbol.trim().toUpperCase();
  if (!raw) return raw;
  return raw
    .replace(/^NSE[:_]/, "")
    .replace(/^NSE_EQ\|/, "")
    .replace(/-EQ$/, "")
    .replace(/\.NS$/, "");
}
export interface SuggestionGenerationDiagnostics {
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  averageDurationMs: number | null;
  runCount: number;
  generated: number;
  eligibleCandidates: number;
  watchlistDateUsed: string | null;
  rejectionCounts: Record<string, number>;
  rejectionSummary?: Record<string, number>;
  note: string | null;
}

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function runInBatches<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, concurrency);
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        results[idx] = await worker(items[idx]!, idx);
      }
    }),
  );
  return results;
}

let lastGenerationDiagnostics: SuggestionGenerationDiagnostics = {
  running: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastDurationMs: null,
  averageDurationMs: null,
  runCount: 0,
  generated: 0,
  eligibleCandidates: 0,
  watchlistDateUsed: null,
  rejectionCounts: {},
  rejectionSummary: {},
  note: null,
};

export function getSuggestionGenerationDiagnostics(): SuggestionGenerationDiagnostics {
  return {
    ...lastGenerationDiagnostics,
    rejectionCounts: { ...lastGenerationDiagnostics.rejectionCounts },
    rejectionSummary: { ...(lastGenerationDiagnostics.rejectionSummary ?? {}) },
  };
}

function summarizeRejections(rejectionCounts: Record<string, number>): Record<string, number> {
  const summary: Record<string, number> = {
    data_unavailable: 0,
    setup_unavailable: 0,
    quality_gate: 0,
    risk_gate: 0,
    capacity_gate: 0,
    execution_guard: 0,
    system_error: 0,
  };

  const add = (key: keyof typeof summary, value: number) => {
    summary[key] = (summary[key] ?? 0) + value;
  };

  for (const [reason, count] of Object.entries(rejectionCounts)) {
    if (reason.startsWith("scan_null_insufficient") || reason === "symbol_not_found") {
      add("data_unavailable", count);
      continue;
    }
    if (reason.startsWith("scan_null_no_setup") || reason.startsWith("scan_null_quality_or_rs")) {
      add("setup_unavailable", count);
      continue;
    }
    if (["hourly_or_score", "min_suggestion_score", "mtf_conflict", "mtf_confluence", "confidence", "market_context"].includes(reason)) {
      add("quality_gate", count);
      continue;
    }
    if (["risk_reward", "position_sizing"].includes(reason)) {
      add("risk_gate", count);
      continue;
    }
    if (["sector_cap", "direction_cap_buy", "direction_cap_sell", "already_open"].includes(reason)) {
      add("capacity_gate", count);
      continue;
    }
    if (["signal_cooldown", "downtrend_vix_long_block", "uptrend_short_block"].includes(reason)) {
      add("execution_guard", count);
      continue;
    }
    if (["scan_timeout", "exception"].includes(reason)) {
      add("system_error", count);
      continue;
    }
  }

  return summary;
}


function getSessionMinuteIST(): number {
  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = (utcMinutes + 330 + 24 * 60) % (24 * 60);
  return istMinutes - (9 * 60 + 15);
}

// ── Optimized LTP fetcher with batching and caching ────────────────────────

export async function fetchLTPForSymbols(
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  const token = getAccessToken();
  if (!token) return {};

  // Map symbols to instrument keys
  const keyMap: Record<string, string> = {};
  const effectiveUniverse = await getEffectiveUniverse();
  for (const s of effectiveUniverse) keyMap[s.symbol] = s.key;

  const instrumentKeys = symbols
    .map((sym) => keyMap[sym])
    .filter((k): k is string => k != null);

  if (instrumentKeys.length === 0) return {};

  try {
    const data = await upstoxClient.fetchLTPForInstruments(
      instrumentKeys,
      token,
    );

    // Map back to symbols
    const result: Record<string, number> = {};
    for (const symbol of symbols) {
      const key = keyMap[symbol];
      if (key && data[key]) {
        result[symbol] = data[key];
      }
    }

    logger.info(
      { fetched: Object.keys(result).length, requested: symbols.length },
      "LTP fetch completed",
    );
    return result;
  } catch (err) {
    logger.error(
      { err, symbols: symbols.length },
      "Failed to fetch LTP for symbols",
    );
    return {};
  }
}

// ── Outcome check ─────────────────────────────────────────────────────────────

export async function runOutcomeCheck(): Promise<void> {
  try {
    const active = await db
      .select({ symbol: suggestionsTable.symbol })
      .from(suggestionsTable)
      .where(eq(suggestionsTable.status, "ACTIVE"));

    if (!active.length) return;

    const symbols = [...new Set(active.map((r) => r.symbol))];
    const prices = await fetchLTPForSymbols(symbols);
    if (Object.keys(prices).length === 0) return;

    await checkSuggestionOutcomes(prices);
  } catch (err) {
    logger.error({ err }, "runOutcomeCheck failed");
  }
}

// ── Sector concentration helper ───────────────────────────────────────────────

async function getOpenSectorCounts(): Promise<Record<string, number>> {
  const open = await db
    .select({ symbol: suggestionsTable.symbol })
    .from(suggestionsTable)
    .where(eq(suggestionsTable.status, "ACTIVE"));

  const counts: Record<string, number> = {};
  for (const row of open) {
    const sector = STOCK_SECTOR_MAP[row.symbol] ?? "Other";
    counts[sector] = (counts[sector] ?? 0) + 1;
  }
  return counts;
}

// ── Main suggestion generator ─────────────────────────────────────────────────

export async function generateSuggestionsFromWatchlist(options?: {
  bypassTimingFilter?: boolean;
  source?: "scheduler" | "manual" | "startup";
  scanSessionId?: string;
}): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastGenerationStartedAtMs < MIN_GENERATION_GAP_MS) {
    logger.info(
      { minGapMs: MIN_GENERATION_GAP_MS },
      "Suggestion generation skipped due to minimum interval guard",
    );
    return;
  }

  if (generationInProgress) {
    logger.warn(
      "Suggestion generation skipped because previous generation is still running",
    );
    return;
  }

  const workflow = beginWorkflow(
    "INTRADAY_GENERATION",
    options?.source ?? "scheduler",
  );
  if (!workflow.ok) {
    logger.warn(
      { reason: workflow.reason },
      "Suggestion generation skipped due to workflow conflict",
    );
    lastGenerationDiagnostics.note = `Skipped: ${workflow.reason}`;
    return;
  }

  generationInProgress = true;
  lastGenerationStartedAtMs = nowMs;
  let workflowSuccess = true;
  let workflowFailureReason: string | undefined;
  lastGenerationDiagnostics = {
    ...lastGenerationDiagnostics,
    running: true,
    lastRunAt: new Date().toISOString(),
    lastDurationMs: null,
    generated: 0,
    eligibleCandidates: 0,
    rejectionCounts: {},
    note: "Generation cycle started.",
  };
  try {
    const cfg = getConfig();
    const state = getMarketState();

    if (state.suggestionsPaused) {
      logger.info(
        { reason: state.pauseReason },
        "Suggestion generation paused",
      );
      lastGenerationDiagnostics.note = `Paused: ${state.pauseReason ?? "unknown reason"}`;
      return;
    }

    if (!getAccessToken()) {
      logger.warn("Suggestion generation skipped — Upstox not authenticated");
      lastGenerationDiagnostics.note = "Skipped: Upstox not authenticated.";
      return;
    }

    const todayIST = getISTDateStr();
    const nextTradingDay = getNextTradingDayStr();

    const openSuggestions = await db
      .select()
      .from(suggestionsTable)
      .where(eq(suggestionsTable.status, "ACTIVE"));

    if (openSuggestions.length >= cfg.maxOpenPositions) {
      logger.info(
        { open: openSuggestions.length, max: cfg.maxOpenPositions },
        "Max open positions reached",
      );
      lastGenerationDiagnostics.note = "Skipped: max open positions reached.";
      return;
    }

    const slotsAvailable = cfg.maxOpenPositions - openSuggestions.length;
    const existingSymbols = new Set(openSuggestions.map((s) => normalizeSymbol(s.symbol)));
    let openBuyCount = openSuggestions.filter((s) => s.direction === "BUY").length;
    let openSellCount = openSuggestions.filter((s) => s.direction === "SELL").length;

    const marketMinute = getSessionMinuteIST();
    if (
      !options?.bypassTimingFilter &&
      marketMinute >= 0 &&
      marketMinute < cfg.avoidFirstMinutes
    ) {
      logger.info({ marketMinute }, "Skipping generation due to execution timing filter");
      lastGenerationDiagnostics.note = "Skipped due to execution timing filter.";
      return;
    }

    // Fetch supporting data in parallel
    const [todayCandidates, nextDayCandidates, corporateBlacklist, sectorCounts, niftyCandles] =
      await Promise.all([
        db
          .select()
          .from(overnightWatchlistTable)
          .where(eq(overnightWatchlistTable.forDate, todayIST)),
        db
          .select()
          .from(overnightWatchlistTable)
          .where(eq(overnightWatchlistTable.forDate, nextTradingDay)),
        fetchCorporateActionBlacklist(),
        getOpenSectorCounts(),
        fetchNiftyDailyCandles(70),
      ]);
    
    let candidates = todayCandidates.length > 0 ? todayCandidates : nextDayCandidates;
    let watchlistDateUsed = todayCandidates.length > 0 ? todayIST : nextTradingDay;

    if (candidates.length === 0) {
      const [latest] = await db
        .select({ forDate: overnightWatchlistTable.forDate })
        .from(overnightWatchlistTable)
        .orderBy(desc(overnightWatchlistTable.forDate))
        .limit(1);
      if (latest?.forDate) {
        candidates = await db
          .select()
          .from(overnightWatchlistTable)
          .where(eq(overnightWatchlistTable.forDate, latest.forDate));
        watchlistDateUsed = latest.forDate;
        logger.info(
          { count: candidates.length, latestDate: latest.forDate },
          "Watchlist empty for today/tomorrow; falling back to latest available watchlist",
        );
      }
    }

    logger.info(
      {
        watchlistCount: candidates.length,
        watchlistDateUsed,
        existingOpen: openSuggestions.length,
        slotsAvailable,
      },
      "Generation cycle started",
    );

    const regime = state.regime;
    if (regime === "TRENDING_DOWN" && state.indiaVix && state.indiaVix > 18) {
      logger.info("Skipping long generation — downtrend with elevated VIX");
    }

    const normalizedCandidates = candidates.map((c) => ({
      ...c,
      symbol: normalizeSymbol(c.symbol),
    }));

    const eligibleCandidates = normalizedCandidates
      .filter((c) => {
        if (c.category === "AVOID") return false;
        if (existingSymbols.has(c.symbol)) return false;
        if (corporateBlacklist.has(c.symbol)) {
          logger.debug(
            { symbol: c.symbol },
            "Skipping — corporate action in next 3 days",
          );
          return false;
        }
        return true;
      })
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .slice(0, slotsAvailable * CANDIDATE_OVERSAMPLE_FACTOR);

    if (!eligibleCandidates.length) {
      logger.warn(
        { watchlistSize: candidates.length, reason: "empty or all filtered" },
        "No eligible candidates available for generation",
      );
      lastGenerationDiagnostics = {
        ...lastGenerationDiagnostics,
        running: false,
        generated: 0,
        eligibleCandidates: 0,
        watchlistDateUsed: watchlistDateUsed,
        rejectionCounts: {},
        note: "No eligible candidates after pre-filters.",
      };
      
      broadcast(
        createServerEvent.scanCompleted({
          suggestionsGenerated: 0,
          duration: Date.now() - nowMs,
          scanSessionId: options?.scanSessionId,
        }),
      );
      
      return;
    }

    logger.info(
      { candidates: eligibleCandidates.length, slots: slotsAvailable },
      "Generating suggestions",
    );
    broadcast(
      createServerEvent.scanStarted({
        stocksToAnalyze: eligibleCandidates.length,
        timestamp: new Date().toISOString(),
        scanSessionId: options?.scanSessionId,
      }),
    );

    let generated = 0;
    const rejectionCounts: Record<string, number> = {};
    const addRejection = (reason: string) => {
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    };


    let completedCount = 0;
    const analyzed = await runInBatches(
      eligibleCandidates,
      SCAN_CONCURRENCY,
      async (candidate) => {
        broadcast(
          createServerEvent.scanProgress({
            current: completedCount,
            total: eligibleCandidates.length,
            currentStock: candidate.symbol,
            status: "ANALYZING",
            scanSessionId: options?.scanSessionId,
          }),
        );
        const stock = await findStockBySymbol(candidate.symbol);
        if (!stock) {
          completedCount++;
          broadcast(
            createServerEvent.scanProgress({
              current: completedCount,
              total: eligibleCandidates.length,
              currentStock: candidate.symbol,
              status: "FAILED",
              reason: "symbol_not_found",
              scanSessionId: options?.scanSessionId,
            }),
          );
          return { candidate, stock: null, result: null, scanNullReason: "symbol_not_found" };
        }
        try {
          const result = await withTimeout(
            scanStock(stock, niftyCandles),
            PER_CANDIDATE_TIMEOUT_MS,
            `scanStock(${stock.symbol})`,
          );
          if (!result) {
            const reason = await diagnoseScanNullReason(stock);
            completedCount++;
            broadcast(
              createServerEvent.scanProgress({
                current: completedCount,
                total: eligibleCandidates.length,
                currentStock: candidate.symbol,
                status: "FAILED",
                reason,
                scanSessionId: options?.scanSessionId,
              }),
            );
            return { candidate, stock, result: null, scanNullReason: reason };
          }
          completedCount++;
          broadcast(
            createServerEvent.scanProgress({
              current: completedCount,
              total: eligibleCandidates.length,
              currentStock: candidate.symbol,
              status: "PASSED",
              scanSessionId: options?.scanSessionId,
            }),
          );
          return { candidate, stock, result, scanNullReason: null };
        } catch (err) {
          logger.error({ err, symbol: candidate.symbol }, "Error scanning candidate");
          completedCount++;
          broadcast(
            createServerEvent.scanProgress({
              current: completedCount,
              total: eligibleCandidates.length,
              currentStock: candidate.symbol,
              status: "FAILED",
              reason: "exception",
              scanSessionId: options?.scanSessionId,
            }),
          );
          return { candidate, stock, result: null, scanNullReason: "exception" };
        }
      },
    );

    const scanResults: ScanResult[] = analyzed
      .map((item) => item.result)
      .filter((r): r is ScanResult => r !== null);

    // Track rejections
    for (const item of analyzed) {
      if (!item.result && item.scanNullReason) {
        addRejection(item.scanNullReason);
      }
    }

    logger.info({ scanResults: scanResults.length }, "Running consolidated scan results through Layer 7 pipeline");
    const pipelineResult = await runIntelligencePipeline(scanResults);

    // Calculate dynamic minimum RR threshold based on India VIX and Market Breadth
    let minRequiredRR = 1.3;
    if (state.indiaVix && state.indiaVix > 16) {
      minRequiredRR += 0.2;
    }
    if (state.declineCount > 0 && state.advanceCount > 0 && state.declineCount > state.advanceCount * 1.5) {
      minRequiredRR += 0.25;
    }

    // Fetch live market prices (LTP) so we never suggest outdated/chased entry prices from daily historical candles
    const candidateSymbols = pipelineResult.signals.map((s) => s.symbol);
    const livePrices = candidateSymbols.length ? await fetchLTPForSymbols(candidateSymbols).catch(() => ({} as Record<string, number>)) : {};

    for (const signal of pipelineResult.signals) {
      if (generated >= slotsAvailable) break;

      // Verify against live market price to ensure we never publish late/chased trades
      const ltp = livePrices[signal.symbol];
      if (ltp && ltp > 0) {
        if (signal.signal === "BUY") {
          // Strict anti-chasing guard: If live price has already passed planned entry by >0.2%, reject as late entry
          if (ltp > signal.entryPrice * 1.002) {
            logger.warn(
              { symbol: signal.symbol, ltp, origEntry: signal.entryPrice },
              "Discarding BUY suggestion: live price has already passed planned entry point (Late Entry / Chased)",
            );
            continue;
          }
          const liveRisk = ltp - signal.stopLoss;
          const liveReward = signal.target1 - ltp;
          const liveRR = liveRisk > 0 ? liveReward / liveRisk : 0;
          if (ltp <= signal.stopLoss || ltp >= signal.target1 || liveRR < minRequiredRR) {
            logger.warn(
              { symbol: signal.symbol, ltp, origEntry: signal.entryPrice, liveRR, minRequiredRR },
              "Discarding suggestion: live price has hit target/stop or risk-reward < minRequiredRR",
            );
            continue;
          }
          signal.riskReward = Number(liveRR.toFixed(2));
        } else if (signal.signal === "SELL") {
          // Strict anti-chasing guard: If live price has already dropped below planned entry by >0.2%, reject as late entry
          if (ltp < signal.entryPrice * 0.998) {
            logger.warn(
              { symbol: signal.symbol, ltp, origEntry: signal.entryPrice },
              "Discarding SELL suggestion: live price has already passed planned entry point (Late Entry / Chased)",
            );
            continue;
          }
          const liveRisk = signal.stopLoss - ltp;
          const liveReward = ltp - signal.target1;
          const liveRR = liveRisk > 0 ? liveReward / liveRisk : 0;
          if (ltp >= signal.stopLoss || ltp <= signal.target1 || liveRR < minRequiredRR) {
            logger.warn(
              { symbol: signal.symbol, ltp, origEntry: signal.entryPrice, liveRR, minRequiredRR },
              "Discarding suggestion: live price has hit target/stop or risk-reward < minRequiredRR",
            );
            continue;
          }
          signal.riskReward = Number(liveRR.toFixed(2));
        }
      }

      // Prevent duplicates: Ensure we don't generate the same suggestion multiple times today
      // even if the previous one hit its target and is no longer ACTIVE
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      
      const [latestOpen] = await db
        .select({ id: suggestionsTable.id })
        .from(suggestionsTable)
        .where(
          and(
            eq(suggestionsTable.symbol, signal.symbol),
            or(
              gte(suggestionsTable.generatedAt, todayStart),
              eq(suggestionsTable.status, "ACTIVE")
            )
          ),
        )
        .limit(1);

      if (latestOpen) continue;

      const candidate = eligibleCandidates.find(c => c.symbol === signal.symbol);
      const isIntraday = candidate?.category?.toUpperCase().includes("INTRADAY") ?? false;
      const tradeType = isIntraday ? "INTRADAY" : "SWING";
      
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const validityTill = isIntraday ? tomorrow.toISOString().slice(0, 10) : "3d";

      const [inserted] = await db
        .insert(suggestionsTable)
        .values({
          symbol: signal.symbol,
          name: signal.name,
          exchange: "NSE",
          direction: signal.signal,
          tradeType,
          setupType: signal.setupType,
          entryPrice: signal.entryPrice.toString(),
          stopLoss: signal.stopLoss.toString(),
          target1: signal.target1.toString(),
          target2: signal.target2 ? signal.target2.toString() : null,
          riskReward: signal.riskReward.toString(),
          quantity: signal.positionSize,
          maxRiskInr: signal.maxRiskInr.toString(),
          stopDistancePct: signal.stopDistancePct.toString(),
          marketRegime: signal.regime,
          reasoning: `[MODE:${signal.rankingProvider === "AI Ranking" ? "AI" : "TECH"}|CF:${signal.confidence.toFixed(0)}|AI:${signal.aiScore.toFixed(0)}|K:${signal.patternScore.toFixed(0)}|C:${signal.chronosScore.toFixed(0)}|T:${signal.technicalScore.toFixed(0)}] [SENTIMENT: ${signal.sentimentScore > 60 ? "BULLISH" : signal.sentimentScore < 40 ? "BEARISH" : "NEUTRAL"}] ${signal.reasoning} Confluence: ${signal.confluence.slice(0, 2).join(", ")}.`,
          validityTill,
          status: "ACTIVE",
          atr: signal.featureVector.atr14.toString(),
          highestPrice: signal.entryPrice.toString(),
          lowestPrice: signal.entryPrice.toString(),
          signalFactors: signal.signalFactors,
        })
        .returning();

      if (inserted) {
        logger.info({
          id: inserted.id,
          symbol: inserted.symbol,
          setupType: inserted.setupType,
          direction: inserted.direction,
          entryPrice: inserted.entryPrice
        }, "Database write: auto suggestion generated and inserted");

        generated++;

        const sector = STOCK_SECTOR_MAP[signal.symbol] ?? "Other";
        sectorCounts[sector] = (sectorCounts[sector] ?? 0) + 1;
        if (signal.signal === "BUY") {
          // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
          openBuyCount += 1;
        } else {
          // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
          openSellCount += 1;
        }

        // Broadcast with typed event
        broadcast(
          createServerEvent.newSuggestion({
            id: inserted.id,
            symbol: inserted.symbol,
            direction: signal.signal as "BUY" | "SELL",
            entryPrice: signal.entryPrice,
            stopLoss: signal.stopLoss,
            target1: signal.target1,
            setupType: signal.setupType,
            riskReward: signal.riskReward,
            scanSessionId: options?.scanSessionId,
          }),
          "suggestions"
        );

        intelligenceBus.publish("suggestionGenerated", {
          suggestion: {
            id: inserted.id,
            instrumentKey: `NSE_EQ|${inserted.symbol}`,
            symbol: inserted.symbol,
            direction: signal.signal as "BUY" | "SELL",
            setup: signal.setupType,
            confidence: signal.confidence,
            entry: signal.entryPrice,
            stopLoss: signal.stopLoss,
            target: signal.target1,
            target1: signal.target1,
            riskReward: signal.riskReward,
            reasoning: [signal.reasoning],
            generatedAt: Date.now(),
            expiresAt: Date.now() + 20 * 60_000,
          } as any
        });

        logger.info(
          {
            symbol: signal.symbol,
            setup: signal.setupType,
            direction: signal.signal,
            rr: signal.riskReward,
            confidence: signal.confidence,
          },
          "New suggestion generated via Layer 7 Pipeline",
        );
      }
    }

    const rejectionSummary = summarizeRejections(rejectionCounts);
    const durationMs = Date.now() - nowMs;
    totalGenerationDurationMs += durationMs;
    const completedRunCount = lastGenerationDiagnostics.runCount + 1;
    lastGenerationDiagnostics = {
      running: false,
      lastRunAt: new Date().toISOString(),
      lastDurationMs: durationMs,
      averageDurationMs: totalGenerationDurationMs / completedRunCount,
      runCount: completedRunCount,
      lastSuccessAt: generated > 0 ? new Date().toISOString() : lastGenerationDiagnostics.lastSuccessAt,
      generated,
      eligibleCandidates: eligibleCandidates.length,
      watchlistDateUsed: watchlistDateUsed,
      rejectionCounts,
      rejectionSummary,
      note:
        generated > 0
          ? "Quality-filtered suggestions generated."
          : (consecutiveZeroGenerationCycles >= 2)
            ? "No suggestion met adaptive quality gates in this cycle."
            : "No suggestion met strict quality gates in this cycle.",
    };
    consecutiveZeroGenerationCycles = generated > 0 ? 0 : consecutiveZeroGenerationCycles + 1;

    logger.info(
      { generated, total: eligibleCandidates.length, rejectionCounts },
      "Suggestion generation complete",
    );
    broadcast(
      createServerEvent.scanCompleted({
        suggestionsGenerated: generated,
        duration: durationMs,
        scanSessionId: options?.scanSessionId,
      }),
    );
  } catch (err) {
    workflowSuccess = false;
    workflowFailureReason =
      err instanceof Error ? err.message : "unknown generation error";
    const durationMs = Date.now() - nowMs;
    broadcast(
      createServerEvent.scanCompleted({
        suggestionsGenerated: 0,
        duration: durationMs,
        scanSessionId: options?.scanSessionId,
      }),
    );
    throw err;
  } finally {
    lastGenerationDiagnostics.running = false;
    generationInProgress = false;
    endWorkflow("INTRADAY_GENERATION", workflowSuccess, workflowFailureReason);
  }
}
