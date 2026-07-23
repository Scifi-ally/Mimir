/**
 * Suggestion Generator
 * ─────────────────────────────────────────────────────────────────────────────
 * Converts today's overnight-watchlist candidates into live suggestion records
 * by re-running technical analysis for fresh entry/stop/target levels,
 * then enforces all risk gates before inserting into the DB.
 */
import { db } from "../../db/src";
import { suggestionsTable, overnightWatchlistTable, rejectedCandidatesTable } from "../../db/src";
import { eq, and, desc, gte, or, inArray, sql } from "drizzle-orm";
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
import { runIntelligencePipeline, type IntelligenceSignal } from "../analysis/signal_generator";
import { checkSuggestionOutcomes, expireOldSuggestions, resolveCounterfactuals } from "./accuracy_tracker";
import { fetchCorporateActionBlacklist } from "../market_data/corporate_actions";
import { isSymbolBanned, getDeliveryPct, getBulkDealSignal, refreshNSEFreeData } from "../market_data/nse_free_data";
import { calibrateConfidence, isSetupDemoted, isSetupDemotedForRegime } from "../analysis/calibration_engine";
import { checkMarketInternals } from "../analysis/market_internals";
import { getGapRisk } from "../analysis/gap_risk";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { logger } from "../lib/logger";
import { intelligenceBus } from "../intelligence/event_bus";
import { createUpstoxClient } from "../lib/upstox-client";
import { getISTDateStr, getNextTradingDayStr, todayStartUTC } from "../lib/ist-time";
import { beginWorkflow, endWorkflow } from "../workflow/coordinator";
import { calculateSuggestionTiming } from "./timing";

// ── Create optimized API client (reused across calls) ────────────────────────

const upstoxClient = createUpstoxClient({ cacheTimeMs: 20 * 1000 });
let generationInProgress = false;

const PER_CANDIDATE_TIMEOUT_MS = 45_000;
const SCAN_CONCURRENCY = 4; // reduced from 6 to minimize memory spikes
const MIN_GENERATION_GAP_MS = 90_000;
const CANDIDATE_OVERSAMPLE_FACTOR = 4;

// Counterfactual-capture dedupe: one rejected-candidate row per
// symbol|setup|direction per window (see logRejectedCandidate).
const REJECTED_DEDUPE_MS = 2 * 60 * 60 * 1000;
const rejectedCandidateDedupe = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - REJECTED_DEDUPE_MS;
  for (const [k, ts] of rejectedCandidateDedupe) {
    if (ts < cutoff) rejectedCandidateDedupe.delete(k);
  }
}, 30 * 60 * 1000).unref();
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
  currentProgress?: number;
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
    if (reason.startsWith("scan_null_insufficient") || reason === "symbol_not_found" || reason === "ltp_unavailable") {
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
    if (["risk_reward", "position_sizing", "setup_demoted", "delivery_pct", "gap_risk"].includes(reason)) {
      add("risk_gate", count);
      continue;
    }
    if (["sector_cap", "direction_cap_buy", "direction_cap_sell", "already_open", "max_open_positions"].includes(reason)) {
      add("capacity_gate", count);
      continue;
    }
    if (["signal_cooldown", "downtrend_vix_long_block", "uptrend_short_block", "fno_ban", "corporate_action", "market_internals"].includes(reason)) {
      add("execution_guard", count);
      continue;
    }
    if (["scan_timeout", "exception", "insert_failed"].includes(reason)) {
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
    // Enforce time stops on the same cadence as price outcome checks.
    await expireOldSuggestions();

    const active = await db
      .select({ symbol: suggestionsTable.symbol })
      .from(suggestionsTable)
      .where(inArray(suggestionsTable.status, ["ACTIVE", "PENDING"]));

    // Pending counterfactuals need prices too, or they only ever resolve by
    // expiry (NEVER_TRIGGERED) and the negative-label capture produces nothing.
    let cfSymbols: { symbol: string }[] = [];
    try {
      cfSymbols = await db
        .selectDistinct({ symbol: rejectedCandidatesTable.symbol })
        .from(rejectedCandidatesTable)
        .where(eq(rejectedCandidatesTable.cfStatus, "PENDING"));
    } catch (err) {
      logger.warn({ err }, "Failed to fetch counterfactual symbols for outcome check");
    }

    if (!active.length && !cfSymbols.length) return;

    const symbols = [...new Set([...active, ...cfSymbols].map((r) => r.symbol))];
    const prices = await fetchLTPForSymbols(symbols);
    if (Object.keys(prices).length === 0) return;

    if (active.length) await checkSuggestionOutcomes(prices);
    if (cfSymbols.length) await resolveCounterfactuals(prices);
  } catch (err) {
    logger.error({ err }, "runOutcomeCheck failed");
  }
}

// ── Sector concentration helper ───────────────────────────────────────────────

async function getOpenSectorCounts(): Promise<Record<string, number>> {
  const open = await db
    .select({ symbol: suggestionsTable.symbol })
    .from(suggestionsTable)
    .where(inArray(suggestionsTable.status, ["ACTIVE", "PENDING"]));

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
      .where(inArray(suggestionsTable.status, ["ACTIVE", "PENDING"]));

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

    // Midday chop window (config-driven, e.g. 12:00–13:30 IST when volume and
    // follow-through are weakest). Same bypass rules as the open filter.
    if (
      !options?.bypassTimingFilter &&
      cfg.avoidMiddayEndMinute > cfg.avoidMiddayStartMinute &&
      marketMinute >= cfg.avoidMiddayStartMinute &&
      marketMinute < cfg.avoidMiddayEndMinute
    ) {
      logger.info({ marketMinute }, "Skipping generation due to midday timing filter");
      lastGenerationDiagnostics.note = "Skipped due to midday timing filter.";
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
        // Warm NSE free-data caches (delivery %, F&O ban list, bulk deals)
        // so per-signal gates in ingestSignal read fresh data synchronously.
        refreshNSEFreeData(),
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
    // Strict mode blocks counter-trend generation at any VIX; legacy only >18.
    const vixHigh = !!state.indiaVix && state.indiaVix > 18;
    const gateOn = cfg.strictRegimeGate || vixHigh;
    const longBlock = regime === "TRENDING_DOWN" && gateOn;
    if (longBlock) {
      logger.info({ strict: cfg.strictRegimeGate, vix: state.indiaVix }, "Skipping long generation — downtrend regime gate");
    }
    const shortBlock = regime === "TRENDING_UP" && gateOn;
    if (shortBlock) {
      logger.info({ strict: cfg.strictRegimeGate, vix: state.indiaVix }, "Skipping short generation — uptrend regime gate");
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

    // Counterfactual capture: persist rejected candidates with their feature
    // vector and planned levels so the outcome poller can resolve what WOULD
    // have happened. Without this the ranker only ever trains on survivors.
    // Fire-and-forget — logging must never slow or fail generation.
    // Deduped per symbol|setup|direction within a 2h window: scans run every
    // 5 min and would otherwise insert ~24 near-identical rows per rejected
    // setup per session, skewing the training distribution toward whatever
    // gets rejected most often.
    const logRejectedCandidate = (signal: IntelligenceSignal, reason: string) => {
      const dedupeKey = `${signal.symbol}|${signal.setupType}|${signal.signal}`;
      const nowMs = Date.now();
      const lastLogged = rejectedCandidateDedupe.get(dedupeKey);
      if (lastLogged != null && nowMs - lastLogged < REJECTED_DEDUPE_MS) return;
      rejectedCandidateDedupe.set(dedupeKey, nowMs);
      db.insert(rejectedCandidatesTable)
        .values({
          symbol: signal.symbol,
          direction: signal.signal,
          setupType: signal.setupType,
          rejectionReason: reason.slice(0, 50),
          entryPrice: signal.entryPrice.toFixed(2),
          stopLoss: signal.stopLoss.toFixed(2),
          target1: signal.target1.toFixed(2),
          confidence: Math.round(signal.confidence),
          marketRegime: signal.regime,
          featureVector: signal.featureVector ?? null,
        })
        .catch((err) => logger.warn({ err, symbol: signal.symbol }, "Failed to log rejected candidate"));
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
          lastGenerationDiagnostics.currentProgress = completedCount;
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
          lastGenerationDiagnostics.currentProgress = completedCount;
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
          lastGenerationDiagnostics.currentProgress = completedCount;
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
          lastGenerationDiagnostics.currentProgress = completedCount;
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

    const isIntradayCandidate = (symbol: string): boolean =>
      eligibleCandidates.find((c) => c.symbol === symbol)?.category?.toUpperCase().includes("INTRADAY") ?? false;

    // Apply outcome-blended calibration BEFORE ranking so slot selection is
    // driven by empirical win rates, not raw model confidence. ingestSignal is
    // told the blend already happened (it is not idempotent).
    for (const signal of pipelineResult.signals) {
      const tradeType = isIntradayCandidate(signal.symbol) ? "INTRADAY" : "SWING";
      const { confidence: calibratedConfidence, empirical } = await calibrateConfidence(
        signal.confidence,
        signal.setupType,
        tradeType,
      );
      if (calibratedConfidence !== signal.confidence) {
        logger.info(
          {
            symbol: signal.symbol,
            setupType: signal.setupType,
            modelConfidence: signal.confidence,
            calibratedConfidence,
            samples: empirical?.samples,
            winRate: empirical?.winRate,
          },
          "Confidence calibrated against realized outcomes",
        );
        signal.confidence = calibratedConfidence;
      }
    }
    // Re-rank on calibrated confidence (pipeline sorted on the raw score).
    pipelineResult.signals.sort((a, b) => b.confidence - a.confidence);

    // Seed per-direction counts from currently open suggestions so the
    // configured same-direction cap is enforced alongside the sector cap.
    const directionCounts: Record<string, number> = {};
    for (const s of openSuggestions) {
      directionCounts[s.direction] = (directionCounts[s.direction] ?? 0) + 1;
    }

    for (const signal of pipelineResult.signals) {
      if (generated >= slotsAvailable) break;

      // Regime gate: no new longs into a downtrend with elevated VIX.
      if (longBlock && signal.signal === "BUY") {
        addRejection("downtrend_vix_long_block");
        continue;
      }
      // Symmetric regime gate: no new shorts into an uptrend with elevated VIX.
      if (shortBlock && signal.signal === "SELL") {
        addRejection("uptrend_short_block");
        continue;
      }

      const ltp = livePrices[signal.symbol];
      if (!ltp || ltp <= 0) {
        addRejection("ltp_unavailable");
        continue;
      }

      const sector = STOCK_SECTOR_MAP[signal.symbol] ?? "Other";
      if ((sectorCounts[sector] ?? 0) >= cfg.maxSectorExposure) {
        addRejection("sector_cap");
        logRejectedCandidate(signal, "sector_cap");
        continue;
      }
      if ((directionCounts[signal.signal] ?? 0) >= cfg.maxSameDirectionOpenPositions) {
        const capReason = signal.signal === "BUY" ? "direction_cap_buy" : "direction_cap_sell";
        addRejection(capReason);
        logRejectedCandidate(signal, capReason);
        continue;
      }

      const rejectionReason = await ingestSignal(signal, ltp, {
        scanSessionId: options?.scanSessionId,
        source: options?.source,
        isIntraday: isIntradayCandidate(signal.symbol),
        minRequiredRR,
        confidenceCalibrated: true,
      });

      if (rejectionReason === null) {
        generated++;
        sectorCounts[sector] = (sectorCounts[sector] ?? 0) + 1;
        directionCounts[signal.signal] = (directionCounts[signal.signal] ?? 0) + 1;
      } else {
        addRejection(rejectionReason);
        logRejectedCandidate(signal, rejectionReason);
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
    endWorkflow("INTRADAY_GENERATION", workflowSuccess, workflowFailureReason, workflow.runToken);
  }
}


// ── Per-symbol ingest lock ────────────────────────────────────────────────────
// Serializes the check-then-insert in ingestSignal per symbol so concurrent
// scheduler + realtime calls can't insert duplicate open suggestions.

const symbolIngestLocks = new Map<string, Promise<void>>();

async function withSymbolLock<T>(symbol: string, fn: () => Promise<T>): Promise<T> {
  const prev = symbolIngestLocks.get(symbol) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  symbolIngestLocks.set(symbol, settled);
  void settled.then(() => {
    if (symbolIngestLocks.get(symbol) === settled) symbolIngestLocks.delete(symbol);
  });
  return run;
}

/**
 * Runs all per-signal gates and inserts the suggestion.
 * Returns null on success, or a rejection-reason string (fed into
 * rejectionCounts / summarizeRejections by the generation loop) on rejection.
 */
export async function ingestSignal(
  signal: IntelligenceSignal,
  livePrice?: number,
  options?: {
    scanSessionId?: string;
    source?: string;
    isIntraday?: boolean;
    minRequiredRR?: number;
    /** Set when the caller already applied calibrateConfidence (batch path). */
    confidenceCalibrated?: boolean;
  }
): Promise<string | null> {
  const ltp = livePrice;
  const marketState = getMarketState();

  // Dynamic R:R floor mirrors the scheduler path (base 1.3, raised in
  // high-VIX / weak-breadth regimes) so the realtime path can't admit
  // lower-R:R trades than the batch generator would.
  let dynamicMinRR = 1.3;
  if (marketState.indiaVix && marketState.indiaVix > 16) {
    dynamicMinRR += 0.2;
  }
  if (
    marketState.declineCount > 0 &&
    marketState.advanceCount > 0 &&
    marketState.declineCount > marketState.advanceCount * 1.5
  ) {
    dynamicMinRR += 0.25;
  }
  const minRequiredRR = options?.minRequiredRR ?? dynamicMinRR;

  // ── Regime execution guards ─────────────────────────────────────────
  // Strict mode (default): counter-trend entries are blocked at ANY VIX level —
  // no longs in TRENDING_DOWN, no shorts in TRENDING_UP. Legacy mode only
  // blocks when VIX > 18.
  {
    const cfg = getConfig();
    const vixElevated = !!marketState.indiaVix && marketState.indiaVix > 18;
    const gateActive = cfg.strictRegimeGate || vixElevated;
    if (gateActive) {
      if (signal.signal === "BUY" && marketState.regime === "TRENDING_DOWN") {
        logger.warn(
          { symbol: signal.symbol, regime: marketState.regime, indiaVix: marketState.indiaVix, strict: cfg.strictRegimeGate },
          "Discarding BUY suggestion: counter-trend entry in downtrend",
        );
        return "downtrend_vix_long_block";
      }
      if (signal.signal === "SELL" && marketState.regime === "TRENDING_UP") {
        logger.warn(
          { symbol: signal.symbol, regime: marketState.regime, indiaVix: marketState.indiaVix, strict: cfg.strictRegimeGate },
          "Discarding SELL suggestion: counter-trend entry in uptrend",
        );
        return "uptrend_short_block";
      }
    }
  }

  // ── NSE free-data gates ─────────────────────────────────────────────
  // Walk-forward demotion: rolling 90d expectancy for this setup is negative.
  if (isSetupDemoted(signal.setupType)) {
    logger.warn({ symbol: signal.symbol, setupType: signal.setupType }, "Discarding suggestion: setup demoted by walk-forward expectancy check");
    return "setup_demoted";
  }

  // Finer gate: setup is fine overall but has proven negative expectancy in
  // the CURRENT regime (>=30 samples in that cell). Cheapest accuracy gain
  // available — pure subtraction based on our own outcome history.
  // Key with signal.regime (fine-grained detector regime): that is the unit
  // stored in suggestions.marketRegime and thus the unit of the demotion
  // cells. marketState.regime is the COARSE legacy mapping and would never
  // match a cell key.
  if (isSetupDemotedForRegime(signal.setupType, signal.regime)) {
    logger.warn(
      { symbol: signal.symbol, setupType: signal.setupType, regime: signal.regime },
      "Discarding suggestion: setup×regime cell demoted by expectancy check",
    );
    return "setup_regime_demoted";
  }

  // F&O ban period: OI limits make these erratic — hard reject.
  if (isSymbolBanned(signal.symbol)) {
    logger.warn({ symbol: signal.symbol }, "Discarding suggestion: symbol in F&O ban period");
    return "fno_ban";
  }

  // Earnings/corp-action blackout: no binary event risk on open positions.
  if (marketState.corporateActionSymbols.has(signal.symbol)) {
    logger.warn({ symbol: signal.symbol }, "Discarding suggestion: corporate event within 3 days");
    return "corporate_action";
  }

  // Market internals: VIX spike halt, breadth + sector-RS gates for momentum.
  const internals = checkMarketInternals(signal.symbol, signal.signal as "BUY" | "SELL", signal.setupType);
  if (!internals.allowed) {
    logger.warn({ symbol: signal.symbol, setupType: signal.setupType, reason: internals.reason }, "Discarding suggestion: market internals gate");
    return "market_internals";
  }

  // Delivery % gate for long momentum: low delivery = intraday churn, the
  // classic fake-breakout signature the backtest showed loses money.
  if (signal.signal === "BUY" && signal.setupType === "MOMENTUM_CONTINUATION") {
    const deliveryPct = getDeliveryPct(signal.symbol);
    if (deliveryPct !== null && deliveryPct < 25) {
      logger.warn(
        { symbol: signal.symbol, deliveryPct },
        "Discarding momentum BUY: delivery % below 25 (speculative churn, not accumulation)",
      );
      return "delivery_pct";
    }
  }

  // Bulk-deal confluence: institutional net flow aligned with direction is a
  // confidence boost; heavy flow against it is a small penalty. Never a gate.
  const bulkDeal = getBulkDealSignal(signal.symbol);
  if (bulkDeal && bulkDeal.netBuyQty !== 0) {
    const aligned = signal.signal === "BUY" ? bulkDeal.netBuyQty > 0 : bulkDeal.netBuyQty < 0;
    signal.confidence = Math.max(0, Math.min(100, signal.confidence + (aligned ? 5 : -5)));
    signal.confluence = [
      ...(signal.confluence ?? []),
      aligned ? "Institutional bulk-deal flow aligned" : "Bulk-deal flow against direction",
    ];
  }

  // VWAP-side alignment: price on the wrong side of session VWAP for the trade
  // direction is the classic counter-flow entry (buying while the average
  // participant is under water). Soft adjustment only — no repo backtest has
  // measured this as a hard gate yet, so it shifts confidence, never rejects.
  const vwapDist = signal.featureVector?.vwapDistance;
  if (typeof vwapDist === "number" && vwapDist !== 0) {
    const vwapAligned = signal.signal === "BUY" ? vwapDist > 0 : vwapDist < 0;
    signal.confidence = Math.max(0, Math.min(100, signal.confidence + (vwapAligned ? 3 : -6)));
    signal.confluence = [
      ...(signal.confluence ?? []),
      vwapAligned
        ? `Price on the right side of VWAP (${vwapDist.toFixed(2)}%)`
        : `Counter-VWAP entry (${vwapDist.toFixed(2)}%) — reduced confidence`,
    ];
  }

  // Live-price gates require a real LTP: without one we'd insert PENDING off
  // stale daily-candle prices and auto-promote at whatever the market moved to.
  if (!ltp || ltp <= 0) {
    logger.warn({ symbol: signal.symbol }, "Discarding suggestion: live price unavailable (LTP fetch failed)");
    return "ltp_unavailable";
  }

  if (signal.signal === "BUY") {
    if (ltp > signal.entryPrice * 1.002) {
      logger.warn({ symbol: signal.symbol, ltp, origEntry: signal.entryPrice }, "Discarding BUY suggestion: live price has already passed planned entry point (Late Entry / Chased)");
      return "risk_reward";
    }
    const liveRisk = ltp - signal.stopLoss;
    const liveReward = signal.target1 - ltp;
    const liveRR = liveRisk > 0 ? liveReward / liveRisk : 0;
    if (ltp <= signal.stopLoss || ltp >= signal.target1 || liveRR < minRequiredRR) {
      logger.warn({ symbol: signal.symbol, ltp, origEntry: signal.entryPrice, liveRR, minRequiredRR }, "Discarding suggestion: live price has hit target/stop or risk-reward < minRequiredRR");
      return "risk_reward";
    }
    signal.riskReward = Number(liveRR.toFixed(2));
  } else if (signal.signal === "SELL") {
    if (ltp < signal.entryPrice * 0.998) {
      logger.warn({ symbol: signal.symbol, ltp, origEntry: signal.entryPrice }, "Discarding SELL suggestion: live price has already passed planned entry point (Late Entry / Chased)");
      return "risk_reward";
    }
    const liveRisk = signal.stopLoss - ltp;
    const liveReward = ltp - signal.target1;
    const liveRR = liveRisk > 0 ? liveReward / liveRisk : 0;
    if (ltp >= signal.stopLoss || ltp <= signal.target1 || liveRR < minRequiredRR) {
      logger.warn({ symbol: signal.symbol, ltp, origEntry: signal.entryPrice, liveRR, minRequiredRR }, "Discarding suggestion: live price has hit target/stop or risk-reward < minRequiredRR");
      return "risk_reward";
    }
    signal.riskReward = Number(liveRR.toFixed(2));
  }

  const isIntraday = options?.isIntraday ?? false;
  const tradeType = isIntraday ? "INTRADAY" : "SWING";

  // Overnight gap risk: don't open new swing positions into a HIGH-risk
  // overnight setup (big implied gap or INR shock) — the stop math is void
  // when the open gaps through it.
  if (tradeType === "SWING") {
    const gapRisk = getGapRisk();
    if (gapRisk?.riskLevel === "HIGH") {
      logger.warn(
        { symbol: signal.symbol, impliedGapPct: gapRisk.impliedGapPct },
        "Discarding SWING suggestion: HIGH overnight gap risk",
      );
      return "gap_risk";
    }
  }

  // Replace uncalibrated model confidence with the outcome-blended score:
  // empirical win rate for this setup×tradeType, weighted by sample count.
  // When the caller already calibrated (batch path, so ranking/selection use
  // the blended score), only the empirical stats are consumed here — the
  // blend is not idempotent, so we must not apply it twice.
  const { confidence: calibratedConfidence, empirical } = await calibrateConfidence(
    signal.confidence,
    signal.setupType,
    tradeType,
  );
  if (!options?.confidenceCalibrated && calibratedConfidence !== signal.confidence) {
    logger.info(
      {
        symbol: signal.symbol,
        setupType: signal.setupType,
        modelConfidence: signal.confidence,
        calibratedConfidence,
        samples: empirical?.samples,
        winRate: empirical?.winRate,
      },
      "Confidence calibrated against realized outcomes",
    );
    signal.confidence = calibratedConfidence;
  }

  // Serialize the remaining check-then-insert per symbol: scheduler and
  // realtime paths run concurrently and could otherwise both pass the
  // duplicate/cap checks before either inserts.
  return withSymbolLock(signal.symbol, async () => {
    const cfg = getConfig();
    const todayStart = todayStartUTC();

    const [latestOpen] = await db
      .select({ id: suggestionsTable.id })
      .from(suggestionsTable)
      .where(
        and(
          eq(suggestionsTable.symbol, signal.symbol),
          or(
            gte(suggestionsTable.generatedAt, todayStart),
            inArray(suggestionsTable.status, ["ACTIVE", "PENDING"])
          )
        )
      )
      .limit(1);

    if (latestOpen) return "already_open";

    // Daily suggestion cap: a handful of high-conviction trades beats spraying
    // entries. Counts every row generated today regardless of current status.
    const [{ todayCount }] = await db
      .select({ todayCount: sql<number>`count(*)::int` })
      .from(suggestionsTable)
      .where(gte(suggestionsTable.generatedAt, todayStart));
    if (todayCount >= cfg.maxSuggestionsPerDay) {
      logger.warn(
        { symbol: signal.symbol, todayCount, max: cfg.maxSuggestionsPerDay },
        "Discarding suggestion: daily suggestion cap reached",
      );
      return "daily_cap";
    }

    // DB-backed capacity gates so the realtime path (which bypasses the batch
    // generator's slot accounting) can't exceed the configured limits.
    const openRows = await db
      .select({ symbol: suggestionsTable.symbol, direction: suggestionsTable.direction })
      .from(suggestionsTable)
      .where(inArray(suggestionsTable.status, ["ACTIVE", "PENDING"]));

    if (openRows.length >= cfg.maxOpenPositions) {
      logger.warn(
        { symbol: signal.symbol, open: openRows.length, max: cfg.maxOpenPositions },
        "Discarding suggestion: max open positions reached",
      );
      return "max_open_positions";
    }

    const sector = STOCK_SECTOR_MAP[signal.symbol] ?? "Other";
    const sectorOpen = openRows.filter((r) => (STOCK_SECTOR_MAP[r.symbol] ?? "Other") === sector).length;
    if (sectorOpen >= cfg.maxSectorExposure) {
      logger.warn(
        { symbol: signal.symbol, sector, sectorOpen, max: cfg.maxSectorExposure },
        "Discarding suggestion: max sector exposure reached",
      );
      return "sector_cap";
    }

    const sameDirectionOpen = openRows.filter((r) => r.direction === signal.signal).length;
    if (sameDirectionOpen >= cfg.maxSameDirectionOpenPositions) {
      logger.warn(
        { symbol: signal.symbol, direction: signal.signal, sameDirectionOpen, max: cfg.maxSameDirectionOpenPositions },
        "Discarding suggestion: max same-direction positions reached",
      );
      return signal.signal === "BUY" ? "direction_cap_buy" : "direction_cap_sell";
    }

    const timing = calculateSuggestionTiming({
      tradeType,
      entryPrice: signal.entryPrice,
      target1: signal.target1,
      atr: signal.featureVector?.atr14,
      empiricalMedianMinutes: empirical?.medianTimeToTargetMin,
    });

    // Honest fill model: only mark ACTIVE if the market is already at/past the
    // planned entry. Otherwise PENDING — accuracy_tracker promotes it when price
    // actually touches entry, so stats never count trades that never filled.
    const entryTouched =
      ltp && ltp > 0
        ? signal.signal === "BUY"
          ? ltp >= signal.entryPrice
          : ltp <= signal.entryPrice
        : false;

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
        confidence: signal.confidence,
        aiScore: signal.aiScore,
        patternScore: signal.patternScore,
        chronosScore: signal.chronosScore,
        technicalScore: signal.technicalScore,
        sentimentScore: signal.sentimentScore,
        rankingMode: signal.rankingProvider,
        reasoning: `[SENTIMENT: ${signal.sentimentScore > 60 ? "BULLISH" : signal.sentimentScore < 40 ? "BEARISH" : "NEUTRAL"}] ${signal.reasoning} Confluence: ${signal.confluence.slice(0, 2).join(", ")}.`,
        validityTill: timing.validityTill,
        expectedHoldMinutes: timing.expectedHoldMinutes,
        expiresAt: timing.expiresAt,
        status: entryTouched ? "ACTIVE" : "PENDING",
        atr: signal.featureVector?.atr14?.toString() || "0",
        highestPrice: signal.entryPrice.toString(),
        lowestPrice: signal.entryPrice.toString(),
        signalFactors: signal.signalFactors,
        // Persist the full feature vector so a model can later be trained on the
        // realized outcome of this exact signal (Phase 1.1). Discarded before now.
        featureVector: signal.featureVector ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      // onConflictDoNothing swallowed the insert — without a row there is no
      // suggestionGenerated event, so the paper engine never sees this signal.
      // Must be loud: a silent drop here looks identical to "no signal at all".
      logger.warn(
        { symbol: signal.symbol, setup: signal.setupType, direction: signal.signal },
        "Suggestion insert returned no row (conflict) — signal NOT published to trading engine",
      );
    }

    if (inserted) {
      logger.info({
        id: inserted.id,
        symbol: inserted.symbol,
        setupType: inserted.setupType,
        direction: inserted.direction,
        entryPrice: inserted.entryPrice
      }, "Database write: auto suggestion generated and inserted");

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
          expiresAt: timing.expiresAt.getTime(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        "New suggestion generated via Layer 7 Pipeline"
      );
      return null;
    }
    logger.warn({ symbol: signal.symbol }, "Suggestion insert returned no row (conflict or failure)");
    return "insert_failed";
  });
}
