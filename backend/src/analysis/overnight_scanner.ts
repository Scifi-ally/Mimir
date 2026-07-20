import { db } from "../../db/src";
import { overnightWatchlistTable } from "../../db/src";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { scanMarket, getEffectiveUniverse, getUniverseDiagnostics } from "./stock_scanner";
import {
  getLastCompletedTradingDayStr,
  getPreviousTradingDayStr,
} from "../lib/ist-time";
import { getTargetTradingSessionDate } from "../market_data/market_state";
import { isAuthenticated } from "../upstox/auth";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { getDataTelemetry, resetDataTelemetry } from "../lib/data_telemetry";
import { beginWorkflow, endWorkflow } from "../workflow/coordinator";
import {
  ensureScanRunTable,
  getSuccessfulScanForDate,
  markScanFinished,
  markScanStarted,
} from "../workflow/scan_persistence";

type ScanWindowResult = Awaited<ReturnType<typeof scanMarket>>[number];

interface AggregatedWatchlistCandidate {
  symbol: string;
  name: string;
  category: string;
  condition: string;
  priority: number;
  direction: "BUY" | "SELL";
  scoreSum: number;
  weightSum: number;
  appearances: number;
  latestScore: number;
  latestDay: string;
}

function fitConditionForStorage(condition: string): string {
  // Sanitize non-ASCII characters (e.g., ₹ -> Rs., … -> ...) to prevent Postgres WIN1252 encoding errors
  let sanitized = condition.replace(/₹/g, 'Rs.').replace(/…/g, '...');
  sanitized = sanitized.replace(/[^\x20-\x7E]/g, '');

  // If it's a JSON string, don't truncate it as that would break JSON validity
  if (sanitized.startsWith('{') && sanitized.endsWith('}')) {
    return sanitized;
  }
  const maxLength = 250; // increased length to prevent pattern_name truncation
  if (sanitized.length <= maxLength) return sanitized;
  return `${sanitized.slice(0, maxLength - 3).trimEnd()}...`;
}

let scanRunning = false;
let lastScanStartedAt: string | null = null;
let lastScanFinishedAt: string | null = null;
let lastScanStatus: "idle" | "running" | "success" | "skipped" | "failed" | "stopped" =
  "idle";
let lastScanMessage: string | null = null;
let lastScanObservability: Record<string, unknown> | null = null;
let lastScanStage: string = "idle";
let activeScanSessionId: string | null = null;
let abortRequested = false;
let terminalScanEventEmitted = false;

export let activeScanCandidates: Array<{ symbol: string; reason?: string }> = [];

export function getActiveScanSessionId(): string | null {
  return activeScanSessionId;
}

export function setActiveScanSessionId(id: string | null): void {
  activeScanSessionId = id;
}

let onScanCompletedCallback: (() => void | Promise<void>) | null = null;
export function registerOnScanCompleted(cb: () => void | Promise<void>) {
  onScanCompletedCallback = cb;
}

export function getOffHoursScanStatus() {
  return {
    running: scanRunning,
    lastScanStartedAt,
    lastScanFinishedAt,
    lastScanStatus,
    lastScanMessage,
    lastScanStage,
    dataTelemetry: getDataTelemetry(),
    observability: lastScanObservability,
    activeCandidates: activeScanCandidates,
  };
}

function getRecentCompletedTradingDays(count = 3): string[] {
  const days: string[] = [];
  let current = getLastCompletedTradingDayStr();
  logger.info({ startDay: current }, "Getting recent completed trading days");

  for (let i = 0; i < count; i++) {
    days.push(current);
    current = getPreviousTradingDayStr(new Date(`${current}T00:00:00.000+05:30`));
  }

  const reversed = days.reverse();
  logger.info({ days: reversed }, "Trading days selected for scan");
  return reversed;
}

function buildCondition(
  result: ScanWindowResult,
  dayCount: number,
  avgScore: number,
  appearances: number,
): string {
  const dailyTag =
    appearances === dayCount
      ? "persistent"
      : appearances >= 2
        ? "repeat"
        : "fresh";
  return JSON.stringify({
    score: `${(avgScore * 10).toFixed(0)}/100`,
    timeframe: `${appearances}/${dayCount}D`,
    frequency: dailyTag.toUpperCase(),
    pattern_name: result.condition,
    category: result.category
  });
}

function aggregateResultsBySymbol(
  days: string[],
  resultsByDay: ScanWindowResult[][],
  source: "scheduler" | "manual" | "startup" = "scheduler"
): AggregatedWatchlistCandidate[] {
  const grouped = new Map<string, AggregatedWatchlistCandidate>();
  const totalDays = days.length;

  resultsByDay.forEach((results, dayIndex) => {
    const day = days[dayIndex]!;
    const recencyWeight =
      dayIndex === totalDays - 1 ? 1 : dayIndex === totalDays - 2 ? 0.8 : 0.6;

    logger.debug(
      { day, resultsCount: results.length, recencyWeight },
      "Processing day results",
    );

    for (const result of results.slice(0, 40)) {
      const direction = result.setup.direction;
      const key = `${result.symbol}:${direction}`;
      const existing = grouped.get(key);
      const weightedScore = result.score * recencyWeight;

      if (!existing) {
        grouped.set(key, {
          symbol: result.symbol,
          name: result.name,
          category: result.category,
          condition: result.condition,
          priority: Math.round(result.score),
          direction,
          scoreSum: weightedScore,
          weightSum: recencyWeight,
          appearances: 1,
          latestScore: result.score,
          latestDay: day,
        });
        continue;
      }

      existing.scoreSum += weightedScore;
      existing.weightSum += recencyWeight;
      existing.appearances += 1;

      if (result.score >= existing.latestScore) {
        existing.category = result.category;
        existing.condition = result.condition;
        existing.latestScore = result.score;
        existing.latestDay = day;
      }
    }
  });

  const allCandidates = [...grouped.values()];
  logger.info(
    { candidatesBeforeFilter: allCandidates.length },
    "Grouped candidates",
  );

  const mapped = allCandidates
    .map((candidate) => {
      const avgScore =
        candidate.weightSum > 0
          ? candidate.scoreSum / candidate.weightSum
          : candidate.latestScore;
      const consistencyBonus =
        candidate.appearances >= 3
          ? 0.9
          : candidate.appearances === 2
            ? 0.5
            : 0;
      const recencyBonus =
        candidate.latestDay === days[days.length - 1] ? 0.4 : 0;
      const finalPriority = Math.min(
        10,
        Math.round(avgScore + consistencyBonus + recencyBonus),
      );

      return {
        ...candidate,
        condition: buildCondition(
          { condition: candidate.condition } as ScanWindowResult,
          totalDays,
          avgScore,
          candidate.appearances,
        ),
        priority: finalPriority,
      };
    });

  const appearanceThreshold = source === "manual" ? 1 : 2;
  const scoreThreshold = source === "manual" ? 6.0 : 7.5;
  const priorityThreshold = source === "manual" ? 6 : 8;

  let filtered = mapped.filter(
    (candidate) =>
      candidate.appearances >= appearanceThreshold &&
      candidate.latestScore >= scoreThreshold &&
      candidate.priority >= priorityThreshold,
  );

  // Fallback: If even the relaxed filter drops everything, just take the top 20 by score to prevent a completely blank UI.
  if (filtered.length === 0 && mapped.length > 0) {
    filtered = mapped.sort((a, b) => b.latestScore - a.latestScore).slice(0, 20);
  }

  logger.info(
    {
      afterFilter: filtered.length,
      filterDetails: filtered
        .slice(0, 5)
        .map((c) => ({
          symbol: c.symbol,
          appearances: c.appearances,
          latestScore: c.latestScore,
          priority: c.priority,
        })),
    },
    "Candidates after filter",
  );

  const sorted = filtered.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.appearances !== a.appearances) return b.appearances - a.appearances;
    return b.latestScore - a.latestScore;
  });

  return sorted.reduce<AggregatedWatchlistCandidate[]>((selected, candidate) => {
    if (selected.some((existing) => existing.symbol === candidate.symbol))
      return selected;
    selected.push(candidate);
    return selected;
  }, []).slice(0, 50);
}

export async function runOvernightScanner(
  testMode = false,
  forceReset = false,
  source: "scheduler" | "manual" | "startup" = "scheduler",
  scanSessionId?: string,
): Promise<void> {
  await ensureScanRunTable();

  if (scanRunning) {
    if (!forceReset) {
      lastScanStatus = "skipped";
      lastScanMessage = "Previous off-hours scan still running";
      logger.warn(lastScanMessage);
      return;
    }
    logger.warn("Force resetting scan state - aborting previous scan");
    scanRunning = false;
  }

  const workflow = beginWorkflow("OFFHOURS_SCAN", source, {
    forceSameJob: forceReset,
  });
  if (!workflow.ok) {
    lastScanStatus = "skipped";
    lastScanMessage = workflow.reason ?? "Workflow conflict";
    logger.warn({ reason: workflow.reason }, "Off-hours scan skipped due to workflow conflict");
    return;
  }

  scanRunning = true;
  abortRequested = false;
  terminalScanEventEmitted = false;
  activeScanSessionId = scanSessionId || null;
  activeScanCandidates = [];
  const currentSessionId = activeScanSessionId;
  let workflowSuccess = true;
  let workflowFailureReason: string | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let universeDiagnostics: any = { source: "static" };
  let strictDataIntegrity = true;
  const scanStartedAtMs = Date.now();
  const tomorrowStr = getTargetTradingSessionDate();

  const emitScanCompleted = (
    suggestionsGenerated: number,
    outcome: "COMPLETED" | "FAILED" | "STOPPED" = "COMPLETED",
    message?: string,
  ) => {
    if (terminalScanEventEmitted) return;
    terminalScanEventEmitted = true;
    broadcast(
      createServerEvent.scanCompleted({
        suggestionsGenerated,
        duration: Date.now() - scanStartedAtMs,
        scanSessionId: activeScanSessionId || undefined,
        outcome,
        message,
      }),
    );
  };

  try {
    resetDataTelemetry();
    lastScanStartedAt = new Date().toISOString();
    lastScanStatus = "running";
    lastScanStage = "initializing";
    lastScanMessage = null;

    const effectiveUniverse = await getEffectiveUniverse();
    universeDiagnostics = getUniverseDiagnostics();
    strictDataIntegrity = (process.env["STRICT_DATA_INTEGRITY"] ?? "true").toLowerCase() !== "false";
    if (strictDataIntegrity && universeDiagnostics.source !== "dynamic") {
      logger.warn(
        "STRICT_DATA_INTEGRITY enabled but dynamic universe unavailable; continuing with fallback universe",
      );
    }
    lastScanStage = "universe_ready";
    const stockLimit = testMode ? Math.min(20, effectiveUniverse.length) : effectiveUniverse.length;
    
    logger.info(
      { stocks: stockLimit, testMode },
      "Overnight scanner started",
    );
  const completedDays = getRecentCompletedTradingDays(3);
  const totalAcrossDays = stockLimit * completedDays.length;

  if (!testMode && !forceReset) {
    const alreadyDone = await getSuccessfulScanForDate(
      "OFFHOURS_SCAN",
      tomorrowStr,
    );
    if (alreadyDone) {
      lastScanStatus = "skipped";
      lastScanStage = "already_done";
      lastScanMessage = `Scan already completed for ${tomorrowStr}`;
      lastScanFinishedAt = new Date().toISOString();
      scanRunning = false;
      endWorkflow("OFFHOURS_SCAN", true, undefined, workflow.runToken);
      return;
    }
  }

  await markScanStarted("OFFHOURS_SCAN", tomorrowStr, source);

  if (!isAuthenticated()) {
    lastScanStatus = "skipped";
    lastScanStage = "auth_missing";
    lastScanMessage = "Upstox token not available";
    lastScanFinishedAt = new Date().toISOString();
    scanRunning = false;
    logger.warn(
      "Overnight scan skipped — Upstox token not available. Authorize to enable full market scanning.",
    );
    broadcast(
      createServerEvent.systemAlert({
        message:
          "Off-hours scan skipped: Upstox token not available. Please authorize first.",
        severity: "warning",
      }),
    );
    await markScanFinished(
      "OFFHOURS_SCAN",
      tomorrowStr,
      "SKIPPED",
      "Upstox token not available",
    );
    endWorkflow("OFFHOURS_SCAN", workflowSuccess, workflowFailureReason, workflow.runToken);
    return;
  }

    lastScanStage = "scanning";


    broadcast(
      createServerEvent.scanStarted({
        stocksToAnalyze: totalAcrossDays,
        timestamp: new Date().toISOString(),
        scanSessionId: activeScanSessionId || undefined,
      }),
    );
    logger.info(
      { scanningDays: completedDays, resultsFor: tomorrowStr },
      "Scanning market for overnight candidates",
    );

    const resultsByDay: ScanWindowResult[][] = [];
    let scannedAcrossDays = 0;
    for (const day of completedDays) {
      if (abortRequested || activeScanSessionId !== currentSessionId) {
        logger.warn("Overnight scanner loop aborted by manual stop or new session");
        await markScanFinished("OFFHOURS_SCAN", tomorrowStr, "SKIPPED", "Scan manually stopped");
        workflowSuccess = false;
        workflowFailureReason = "Scan manually stopped";
        lastScanStatus = "stopped";
        lastScanMessage = workflowFailureReason;
        emitScanCompleted(0, "STOPPED", workflowFailureReason);
        return;
      }
      lastScanStage = `scanning_${day}`;
      logger.info({ day }, "Scanning market for day");
      const results = await scanMarket(
        stockLimit,
        day,
        (progress) => {
          if (abortRequested || activeScanSessionId !== currentSessionId) return;
          const adjustedCurrent = scannedAcrossDays + progress.current;
          
          if (progress.status === "PASSED" || progress.status === "NEW_SUGGESTION") {
            if (!activeScanCandidates.some(c => c.symbol === progress.currentStock)) {
              activeScanCandidates.push({ symbol: progress.currentStock, reason: progress.reason });
              if (activeScanCandidates.length > 50) {
                activeScanCandidates.shift(); // Keep only the latest 50
              }
            }
          } else if (progress.status === "REJECTED") {
            activeScanCandidates = activeScanCandidates.filter(c => c.symbol !== progress.currentStock);
          }

          broadcast(
            createServerEvent.scanProgress({
              current: Math.min(adjustedCurrent, totalAcrossDays),
              total: totalAcrossDays,
              currentStock: progress.currentStock,
              status: progress.status,
              reason: progress.reason,
              scanSessionId: activeScanSessionId || undefined,
            }),
          );
        },
        () => abortRequested || activeScanSessionId !== currentSessionId
      );
      logger.info({ day, resultsCount: results.length }, "Market scan completed for day");
      resultsByDay.push(results);
      scannedAcrossDays += stockLimit;
    }

    logger.info(
      { days: completedDays, resultsByDay: resultsByDay.map((r) => r.length) },
      "Aggregating results from all days",
    );
    lastScanStage = "aggregating";
    const candidates = aggregateResultsBySymbol(completedDays, resultsByDay, source)
      .slice(0, 20)
      .map((candidate) => ({
        forDate: tomorrowStr,
        symbol: candidate.symbol,
        name: candidate.name ? candidate.name.substring(0, 95) : "",
        category: candidate.category ? candidate.category.substring(0, 29) : "",
        condition: fitConditionForStorage(candidate.condition),
        priority: candidate.priority,
      }));

    if (!candidates.length) {
      lastScanStatus = "success";
      lastScanMessage = `No persistent setups for ${tomorrowStr}`;
      lastScanFinishedAt = new Date().toISOString();
      scanRunning = false;
      logger.info(
        { date: tomorrowStr, days: completedDays },
        "No persistent setups found in rolling downtime scan",
      );
      emitScanCompleted(0);
      await markScanFinished(
        "OFFHOURS_SCAN",
        tomorrowStr,
        "SUCCESS",
        `No persistent setups for ${tomorrowStr}`,
        { candidateCount: 0 },
      );
      if (onScanCompletedCallback) {
        void onScanCompletedCallback();
      }
      return;
    }

    logger.info(
      {
        foundCandidates: candidates.length,
        topSymbols: candidates
          .slice(0, 5)
          .map((c) => `${c.symbol}:${c.priority}`),
        days: completedDays,
      },
      "Rolling downtime candidates found",
    );

    // Safe swap: delete the old table data for tomorrow and insert the new ones in a transaction
    if (candidates.length > 0) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(overnightWatchlistTable).where(eq(overnightWatchlistTable.forDate, tomorrowStr));
          await tx.insert(overnightWatchlistTable).values(candidates);
        });
      } catch (dbErr) {
        logger.error({ err: dbErr, date: tomorrowStr, candidateCount: candidates.length }, "Failed to save overnight candidates to database");
        let errorMsg = dbErr instanceof Error ? dbErr.message : "Unknown error";
        // Truncate long SQL queries in the error message sent to the frontend
        if (errorMsg.length > 150) {
          errorMsg = errorMsg.substring(0, 150) + "...";
        }
        throw new Error(`Database error: ${errorMsg}`, { cause: dbErr });
      }
    }

    logger.info(
      {
        count: candidates.length,
        date: tomorrowStr,
        topSymbols: candidates.slice(0, 3).map((c) => c.symbol),
      },
      "Overnight candidates saved successfully.",
    );

    // Calculate category counts and emit event
    const counts: Record<string, number> = {};
    candidates.forEach(c => {
      counts[c.category] = (counts[c.category] || 0) + 1;
    });
    counts["ALL"] = candidates.length;
    
    broadcast(createServerEvent.watchlistCounts(counts), "watchlist");
    lastScanStatus = "success";
    lastScanStage = "completed";
    lastScanFinishedAt = new Date().toISOString();
    const telemetry = getDataTelemetry();
    lastScanObservability = {
      strictDataIntegrity,
      universe: {
        requested: stockLimit,
        diagnostics: universeDiagnostics,
      },
      telemetry,
      completedDays,
      candidateCount: candidates.length,
      finishedAt: new Date().toISOString(),
    };
    lastScanMessage = `Updated ${candidates.length} candidates for ${tomorrowStr} | candles:${telemetry.historicalCandlesReturned} api:${telemetry.historicalApiCalls}`;
    emitScanCompleted(candidates.length);
    await markScanFinished(
      "OFFHOURS_SCAN",
      tomorrowStr,
      "SUCCESS",
      lastScanMessage,
      { candidateCount: candidates.length, telemetry },
    );
    if (onScanCompletedCallback) {
      void onScanCompletedCallback();
    }
  } catch (err) {
    workflowSuccess = false;
    workflowFailureReason =
      err instanceof Error ? err.message : "Off-hours scan failed";
    lastScanStatus = "failed";
    lastScanStage = "failed";
    lastScanMessage =
      err instanceof Error ? err.message : "Off-hours scan failed";
    logger.error({ err }, "Overnight scanner failed");
    broadcast(
      createServerEvent.systemAlert({
        message: `Off-hours scan failed: ${err instanceof Error ? err.message : "Check backend logs"}`,
        severity: "error",
      }),
    );
    lastScanObservability = {
      strictDataIntegrity,
      universe: universeDiagnostics,
      telemetry: getDataTelemetry(),
      error: err instanceof Error ? err.message : "unknown",
      finishedAt: new Date().toISOString(),
    };
    emitScanCompleted(0, "FAILED", lastScanMessage);
    await markScanFinished(
      "OFFHOURS_SCAN",
      tomorrowStr,
      "FAILED",
      err instanceof Error ? err.message : "Off-hours scan failed",
    );
  } finally {
    if (lastScanStatus === "running") {
      lastScanStage = "finished";
    }
    scanRunning = false;
    activeScanCandidates = [];
    endWorkflow("OFFHOURS_SCAN", workflowSuccess, workflowFailureReason, workflow.runToken);
  }
}

export function abortOvernightScanner(): boolean {
  const wasRunning = scanRunning;
  if (!wasRunning) return false;
  logger.warn("Manual abort requested for overnight scanner");
  abortRequested = true;
  scanRunning = false;
  activeScanCandidates = [];
  lastScanStatus = "stopped";
  lastScanMessage = "Scan manually stopped";
  lastScanFinishedAt = new Date().toISOString();
  lastScanStage = "stopped";
  activeScanSessionId = null;
  broadcast(
    createServerEvent.systemAlert({
      message: "Scan manually stopped",
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
  if (!terminalScanEventEmitted) {
    terminalScanEventEmitted = true;
    broadcast(
      createServerEvent.scanCompleted({
        suggestionsGenerated: 0,
        duration: 0,
        outcome: "STOPPED",
        message: lastScanMessage,
      })
    );
  }
  return wasRunning;
}
