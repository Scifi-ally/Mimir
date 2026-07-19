import cron, { type ScheduledTask } from "node-cron";
import { logger } from "../lib/logger";
import { detectRegime } from "../analysis/regime_detector";
import { runLearningPipeline } from "../analysis/learning_engine";
import {
  updateMarketOpenStatus,
  isMarketOpen,
  computeSessionPhase,
  computeDashboardSession,
  minutesUntilOpen,
  formatMinutesAsCountdown,
  updateMarketState,
} from "../market_data/market_state";
import {
  expireOldSuggestions,
  expireTodayIntraday,
} from "../suggestions/accuracy_tracker";
import {
  runOutcomeCheck,
  generateSuggestionsFromWatchlist,
} from "../suggestions/generator";
import {
  updateMarketFeed,
  initMarketFeed,
  resetMarketFeedCache,
} from "../market_data/market_feed";
import { getOffHoursScanStatus, runOvernightScanner, registerOnScanCompleted } from "../analysis/overnight_scanner";
import { enrichWatchlistWithIntradayOpportunities } from "../analysis/intraday_scanner";
import { savePostMarketData } from "../analysis/post_market";
import { runGapScan } from "../analysis/gap_scanner";
import { fetchFIIDIIData } from "../market_data/fii_dii";
import { refreshNSEFreeData } from "../market_data/nse_free_data";
import { refreshCalibration, refreshSetupDemotions } from "../analysis/calibration_engine";
import { fetchGapRisk } from "../analysis/gap_risk";
import { fetchCorporateActionBlacklist } from "../market_data/corporate_actions";
import {
  runPostMarketFullScan,
} from "../analysis/post_market_scanner";
import {
  initIntradayMonitoring,
  runMonitoringCycle,
  startMonitoring,
  stopMonitoring,
  getMonitoringStatus,
} from "../analysis/intraday_monitor";
import { stopTickFeeder } from "../market_data/tick_feeder";
import {
  getMonitoredSubscriptionStocks,
  syncMonitoredSubscriptions,
} from "../market_data/monitored_symbols";

import { marketIntelligence } from "../intelligence/orchestrator";
import { db } from "../../db/src";
import { suggestionsTable } from "../../db/src";

import { and, eq, gte } from "drizzle-orm";
import { getConfig } from "../config";
import { broadcast } from "../ws/websocket_server";
import {
  getISTDateStr,

  getNextTradingDayStr,
  todayStartUTC,
} from "../lib/ist-time";
import { evaluateAutomationHealth } from "../analysis/confidence_engine";
import { getSuccessfulScanForDate } from "../workflow/scan_persistence";

// HIGH FIX (Issue #10, #18): Add Redis-based distributed locking for scheduler jobs
import crypto from "crypto";
import { createRedisClient } from "../lib/redis";

const SCHEDULER_TIMEZONE = "Asia/Kolkata";
let schedulerRunning = false;
const runningJobs = new Set<string>();
// Handles for every cron task registered by this scheduler run. stopScheduler
// must stop these — clearing only the timers leaves ~25 crons firing against
// a "stopped" scheduler, and a restart would register every job twice.
const cronTasks: ScheduledTask[] = [];
let marketFeedRealtimeTimer: ReturnType<typeof setInterval> | null = null;
let intradayMonitoringTimer: ReturnType<typeof setTimeout> | null = null;
let marketOpenRetryTimer: ReturnType<typeof setInterval> | null = null;
// Incremented each time beginMarketOpenMonitoring starts a fresh monitoring
// loop; stale loops observe the bump and stop re-arming themselves.
let monitoringLoopGeneration = 0;
const ENABLE_INTRADAY_WATCHLIST_ENRICHMENT =
  (process.env["ENABLE_INTRADAY_WATCHLIST_ENRICHMENT"] ?? "true").toLowerCase() === "true";
const MONITORING_INTERVAL_MS = 300; // Run monitoring cycle every 300ms during market hours
const MARKET_OPEN_SCAN_WAIT_MS = 60_000;

// HIGH FIX (Issue #10): Distributed lock helper to prevent duplicate scheduler execution
const redisLockClient = createRedisClient("scheduler-locks");
let redisLockConnected = false;

type LockResult =
  | { status: "acquired"; lockValue: string }
  | { status: "held-elsewhere" }
  | { status: "redis-unavailable" };

async function acquireDistributedLock(lockKey: string, ttlSeconds: number = 60): Promise<LockResult> {
  try {
    if (!redisLockConnected) {
      await redisLockClient.connect();
      redisLockConnected = true;
    }

    const lockValue = crypto.randomUUID();
    const acquired = await redisLockClient.set(
      `scheduler:lock:${lockKey}`,
      lockValue,
      'EX', ttlSeconds,
      'NX'
    );

    return acquired ? { status: "acquired", lockValue } : { status: "held-elsewhere" };
  } catch (err) {
    // Redis being down must NOT silently disable critical scheduler jobs.
    // The local runningJobs set still prevents same-process overlap; the only
    // risk is multi-instance overlap, which is preferable to jobs never running.
    logger.error({ err, lockKey }, "Redis unavailable for distributed lock — running with local lock only");
    return { status: "redis-unavailable" };
  }
}

async function releaseDistributedLock(lockKey: string, lockValue: string): Promise<void> {
  try {
    // Lua script ensures we only delete our own lock
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redisLockClient.eval(script, 1, `scheduler:lock:${lockKey}`, lockValue);
  } catch (err) {
    logger.warn({ err, lockKey }, "Failed to release distributed lock");
  }
}
async function beginMarketOpenMonitoring(): Promise<void> {
  logger.info(
    "Market open: priming market feed, initializing tick feeder and monitoring",
  );
  await initMarketFeed();
  await updateMarketFeed();
  await refreshCorporateActions();
  await marketIntelligence.start();

  const subscriptionStocks = await getMonitoredSubscriptionStocks();
  logger.info(
    { stocks: subscriptionStocks.length },
    "Initializing tick feeder for monitored watchlist stocks",
  );
  await syncMonitoredSubscriptions();

  logger.info("Initializing intraday monitoring for watchlist stocks");
  await initIntradayMonitoring();
  startMonitoring();

  if (intradayMonitoringTimer) clearTimeout(intradayMonitoringTimer);
  // Generation token: an in-flight cycle from a previous invocation re-arms
  // itself in its finally block AFTER the clearTimeout above, which would
  // leave two concurrent loops hammering runMonitoringCycle. Bumping the
  // generation makes any older loop exit at its next iteration.
  const myGeneration = ++monitoringLoopGeneration;

  async function scheduleNextMonitoringCycle() {
    if (myGeneration !== monitoringLoopGeneration) return; // superseded loop
    if (!isMarketOpen()) {
      stopMonitoring();
      return;
    }

    const startTime = Date.now();
    try {
      await runMonitoringCycle();
    } catch (err) {
      logger.error({ err }, "Monitoring cycle execution error");
    } finally {
      if (myGeneration === monitoringLoopGeneration) {
        const elapsed = Date.now() - startTime;
        const delay = Math.max(10, MONITORING_INTERVAL_MS - elapsed);
        intradayMonitoringTimer = setTimeout(() => {
          void scheduleNextMonitoringCycle();
        }, delay);
      }
    }
  }

  void scheduleNextMonitoringCycle();

  await generateSuggestionsFromWatchlist({ source: "scheduler" });

  broadcast({
    event: "system_alert",
    data: {
      message:
        "Market opened. Tick-by-tick monitoring active for real-time signal detection.",
    },
  });
}

export function isSchedulerRunning(): boolean {
  return schedulerRunning;
}

// ARCHITECTURAL FIX (Issue #38): Add cleanup function for graceful shutdown
export function stopScheduler(): void {
  if (!schedulerRunning) {
    logger.info("Scheduler already stopped");
    return;
  }
  
  schedulerRunning = false;

  // Stop all cron tasks so no job fires against a stopped scheduler and a
  // subsequent startScheduler() doesn't double-register every job.
  for (const task of cronTasks) {
    try {
      task.stop();
    } catch (err) {
      logger.warn({ err }, "Failed to stop cron task");
    }
  }
  cronTasks.length = 0;

  // Clear all timers
  if (marketFeedRealtimeTimer) {
    clearInterval(marketFeedRealtimeTimer);
    marketFeedRealtimeTimer = null;
  }
  
  if (intradayMonitoringTimer) {
    clearTimeout(intradayMonitoringTimer);
    intradayMonitoringTimer = null;
  }
  
  if (marketOpenRetryTimer) {
    clearInterval(marketOpenRetryTimer);
    marketOpenRetryTimer = null;
  }
  
  // Close Redis lock client
  if (redisLockConnected) {
    redisLockClient.quit().catch(err => 
      logger.warn({ err }, "Failed to close Redis lock client")
    );
    redisLockConnected = false;
  }
  
  logger.info("Scheduler stopped successfully");
}

// HIGH FIX (Issue #10, #18): Enhanced runExclusive with distributed locking
async function runExclusive(
  name: string,
  task: () => void | Promise<void>,
  useDistributedLock: boolean = false
): Promise<void> {
  // Local lock check
  if (runningJobs.has(name)) {
    logger.warn(
      { job: name },
      "Skipping scheduler job because previous run is still active (local check)",
    );
    return;
  }

  // Distributed lock for critical jobs
  let lockValue: string | null = null;
  if (useDistributedLock) {
    const lock = await acquireDistributedLock(name, 300); // 5 min TTL for long-running jobs
    if (lock.status === "held-elsewhere") {
      logger.warn(
        { job: name },
        "Skipping scheduler job because another instance is running (distributed lock)",
      );
      return;
    }
    // redis-unavailable → proceed with local lock only (never silently disable jobs)
    lockValue = lock.status === "acquired" ? lock.lockValue : null;
  }

  runningJobs.add(name);
  try {
    await task();
  } catch (err: unknown) {
    const error = err as Error & { name?: string; isAxiosError?: boolean; response?: { status?: number }; code?: string; config?: { url?: string } };
    if (error && (error.name === "AxiosError" || error.isAxiosError)) {
      logger.error(
        {
          job: name,
          status: error.response?.status,
          message: error.message,
          code: error.code,
          url: error.config?.url,
        },
        "Scheduler job failed (AxiosError)",
      );
    } else {
      logger.error({ err, job: name }, "Scheduler job failed");
    }
  } finally {
    runningJobs.delete(name);
    if (lockValue && useDistributedLock) {
      await releaseDistributedLock(name, lockValue);
    }
  }
}

function scheduleJob(
  name: string,
  expression: string,
  task: () => void | Promise<void>,
): void {
  cronTasks.push(
    cron.schedule(expression, () => void runExclusive(name, task), {
      timezone: SCHEDULER_TIMEZONE,
    }),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function updateDailyLoss(): Promise<void> {
  try {
    const rows = await db
      .select({ pnlInr: suggestionsTable.pnlInr })
      .from(suggestionsTable)
      .where(
        and(
          gte(suggestionsTable.closedAt, todayStartUTC()),
          eq(suggestionsTable.status, "STOP_HIT"),
        ),
      );

    const dailyLoss = rows.reduce((sum, r) => {
      const v = r.pnlInr != null ? parseFloat(r.pnlInr) : 0;
      return sum + (v < 0 ? v : 0);
    }, 0);

    const cfg = getConfig();
    const lossLimit = cfg.tradingCapital * (cfg.maxDailyLossPct / 100);
    const limitHit = Math.abs(dailyLoss) >= lossLimit;
    const weekStart = new Date(todayStartUTC());
    weekStart.setUTCDate(weekStart.getUTCDate() - 7);
    const weeklyRows = await db
      .select({ pnlInr: suggestionsTable.pnlInr })
      .from(suggestionsTable)
      .where(gte(suggestionsTable.closedAt, weekStart));
    const weeklyPnl = weeklyRows.reduce((sum, r) => {
      const v = r.pnlInr != null ? parseFloat(r.pnlInr) : 0;
      return sum + v;
    }, 0);
    const weeklyLossLimit = cfg.tradingCapital * (cfg.weeklyLossLimitPct / 100);
    const weeklyLimitHit = Math.abs(Math.min(weeklyPnl, 0)) >= weeklyLossLimit;

    const rollingRows = await db
      .select({ pnlInr: suggestionsTable.pnlInr, status: suggestionsTable.status, closedAt: suggestionsTable.closedAt })
      .from(suggestionsTable)
      .where(gte(suggestionsTable.closedAt, weekStart))
      // Equity-curve walk requires chronological order — without it Postgres
      // heap order shuffles the peak-to-trough sequence and maxDd is fiction.
      .orderBy(suggestionsTable.closedAt);
    const realized = rollingRows
      .filter((r) => r.status !== "ACTIVE")
      .map((r) => (r.pnlInr != null ? parseFloat(r.pnlInr) : 0))
      .slice(-30);
    let equity = 0;
    let peak = 0;
    let maxDd = 0;
    for (const p of realized) {
      equity += p;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDd) maxDd = dd;
    }
    const rollingDdHit =
      cfg.tradingCapital > 0 &&
      (maxDd / cfg.tradingCapital) * 100 >= cfg.rollingDrawdownPct;

    if (limitHit || weeklyLimitHit || rollingDdHit) {
      updateMarketState({
        suggestionsPaused: true,
        pauseReason: limitHit
          ? "Daily loss limit reached"
          : weeklyLimitHit
            ? "Weekly loss limit reached"
            : "Rolling drawdown limit reached",
      });
      broadcast({
        event: "daily_loss_limit_reached",
        data: {
          totalDailyLoss: Math.round(Math.abs(Math.min(dailyLoss, 0)) * 100) / 100,
          limit: Math.round(lossLimit * 100) / 100,
        },
      });
    }
  } catch (err) {
    logger.error({ err }, "Failed to update daily loss tally");
  }
}

async function refreshFIIDII(): Promise<void> {
  try {
    const data = await fetchFIIDIIData();
    if (data) {
      updateMarketState({
        fiiNetInr: data.fiiNetInr,
        diiNetInr: data.diiNetInr,
      });
      logger.info(
        { fii: data.fiiNetInr, dii: data.diiNetInr },
        "FII/DII data applied to market state",
      );
      detectRegime(); // re-run regime with fresh FII/DII context
    }
  } catch (err) {
    logger.warn({ err }, "FII/DII refresh failed");
  }
}

async function refreshCorporateActions(): Promise<void> {
  try {
    const blacklist = await fetchCorporateActionBlacklist();
    updateMarketState({ corporateActionSymbols: blacklist });
    logger.info(
      { count: blacklist.size },
      "Corporate action blacklist applied to market state",
    );
  } catch (err) {
    logger.warn({ err }, "Corporate actions refresh failed");
  }
}

async function monitorAutomationHealth(): Promise<void> {
  try {
    const health = await evaluateAutomationHealth(40);
    if (!health.shouldPause) return;

    updateMarketState({
      suggestionsPaused: true,
      pauseReason: `Auto-paused: ${health.reason}`,
    });
    broadcast({
      event: "system_alert",
      data: {
        message: `Automation paused: win-rate ${health.winRate}% | avg PnL ${health.avgPnl}`,
        severity: "warning",
      },
    });
    logger.warn({ health }, "Automation auto-paused due to degraded performance");
  } catch (err) {
    logger.error({ err }, "Automation health monitor failed");
  }
}

let reconciliationWarned = false;
async function runStateReconciliation(): Promise<void> {
  const config = getConfig();
  if (config.paperTradingEnabled) return; // Only applicable for live trading reconciliation

  try {
    // Fetch live positions from Upstox (aborting safely if getPositions is unimplemented rather than mocking 0 positions)
    if (!reconciliationWarned) {
      reconciliationWarned = true;
      logger.warn("State reconciliation skipped — live trading order placement (placeOrder/getPositions) is not implemented. Set paperTradingEnabled=true or implement broker integration. (logged once)");
    }
    return;
  } catch (err) {
    logger.error({ err }, "State reconciliation failed");
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

import { fetchGlobalMacroData } from "../analysis/global_macro";
import { fetchOptionsSentimentData } from "../analysis/options_sentiment";

export function startScheduler(): void {
  if (schedulerRunning) {
    logger.warn("Scheduler is already running");
    return;
  }
  
  schedulerRunning = true;
  logger.info({ timezone: SCHEDULER_TIMEZONE }, "Scheduler started");

  // Fetch initial baseline data so the UI isn't empty on off-hours restarts
  setTimeout(() => {
    logger.info("Startup: fetching initial macro and FII/DII data");
    void fetchGlobalMacroData();
    void fetchOptionsSentimentData();
    void refreshFIIDII();
  }, 5000);

  // Macro & Options Sentiment fetching (Every 5 minutes during market hours)
  cronTasks.push(
    cron.schedule("*/5 9-15 * * 1-5", () => {
      void runExclusive("macro-data-fetch", async () => {
        logger.info("Fetching global macro & options sentiment data...");
        await fetchGlobalMacroData();
        await fetchOptionsSentimentData();
      });
    }, { timezone: SCHEDULER_TIMEZONE }),
  );

  // ── Every minute: update market status and session phase ─────────────────
  let lastBroadcastSession: string | null = null;
  scheduleJob("market-status", "* * * * *", () => {
    updateMarketOpenStatus();
    const session = computeDashboardSession();
    if (session !== lastBroadcastSession) {
      lastBroadcastSession = session;
      const minsUntilOpen = minutesUntilOpen();
      broadcast({
        event: "session_state_changed",
        data: {
          session,
          phase: computeSessionPhase(),
          minutesUntilOpen: minsUntilOpen,
          opensIn: formatMinutesAsCountdown(minsUntilOpen),
        },
      });
    }
    // Also run state reconciliation to catch phantom orders
    if (isMarketOpen()) {
      void runExclusive("state-reconciliation", async () => {
        await runStateReconciliation();
      });
    }
  });

  // Realtime market feed updates during market hours.
  if (!marketFeedRealtimeTimer) {
    marketFeedRealtimeTimer = setInterval(() => {
      if (isMarketOpen()) {
        void runExclusive("market-feed-realtime", async () => {
          await updateMarketFeed();
        });
      }
    }, 10_000);
  }

  // ── Every 2 min during market hours: update Nifty + VIX, detect regime ───
  scheduleJob("market-feed", "*/2 * * * *", async () => {
    if (isMarketOpen()) {
      await updateMarketFeed();
    }
  });

  // ── Off-hours feed refresh: keep last known Nifty/VIX available in UI ────
  scheduleJob("market-feed-offhours", "*/15 * * * *", async () => {
    if (!isMarketOpen()) {
      await updateMarketFeed();
    }
  });

  // ── Every minute during market hours: check suggestion outcomes ──────────
  scheduleJob("outcome-check", "* * * * *", async () => {
    if (isMarketOpen()) {
      await runOutcomeCheck();
    }
  });

  // ── Every 5 min during market hours: continuous intraday suggestion generation ──
  // Uses multi-timeframe analysis to catch intraday setups as they develop
  // Continuously generates suggestions throughout the day, not just at open
  scheduleJob("intraday-generation", "*/5 9-15 * * 1-5", async () => {
    if (isMarketOpen()) {
      logger.info(
        "Intraday: generating suggestions from continuous market analysis",
      );
      await generateSuggestionsFromWatchlist({ source: "scheduler" });
    }
  });

  // ── At :45 of each market hour (09:45–14:45): enrich watchlist ───────────
  // Adds new high-confidence intraday setups to the watchlist as they develop.
  // (15:45 also matches but is dead — isMarketOpen() is false after 15:30.)
  scheduleJob("intraday-watchlist-enrichment", "45 9-15 * * 1-5", async () => {
    if (isMarketOpen() && ENABLE_INTRADAY_WATCHLIST_ENRICHMENT) {
      logger.info("Intraday: enriching watchlist with developing setups");
      try {
        await enrichWatchlistWithIntradayOpportunities();
      } catch (err) {
        logger.warn({ err }, "Intraday watchlist enrichment failed");
      }
    }
  });

  // ── Every minute during market hours: check daily loss limit ─────────────
  scheduleJob("daily-loss", "* * * * *", async () => {
    if (isMarketOpen()) {
      await updateDailyLoss();
    }
  });

  // Every 15 minutes during market hours: degrade guard for full automation
  scheduleJob("automation-health-monitor", "*/15 9-15 * * 1-5", async () => {
    if (isMarketOpen()) {
      await monitorAutomationHealth();
    }
  });

  // ── Custom Screener Scheduled Runs ───────────────────────────────────────
  scheduleJob("custom-screener-engine", "* 9-15 * * 1-5", async () => {
    // Legacy scheduled screener runs have been deprecated in favor of a daily idempotent run
    logger.debug("Legacy evaluateCustomScreenerSchedules hook removed");
  });

  // ── 07:00 IST (01:30 UTC) Mon–Fri — FII/DII data for the day ─────────────
  // NSE publishes the previous day's FII/DII flows by early morning.
  // Fetching early gives us institutional bias context for the entire session.
  scheduleJob("fii-dii-refresh", "0 7 * * 1-5", async () => {
    logger.info("Early morning: refreshing FII/DII data");
    await refreshFIIDII();
  });

  // ── 07:30 IST (02:00 UTC) Mon–Fri — corporate action blacklist ────────────
  // Refreshed daily so we don't generate suggestions into earnings/dividends.
  scheduleJob("corporate-actions-refresh", "30 7 * * 1-5", async () => {
    logger.info("Pre-market: refreshing corporate action blacklist");
    await refreshCorporateActions();
  });

  // ── 07:45 IST Mon–Fri — NSE free data (delivery %, F&O ban, bulk deals) ──
  scheduleJob("nse-free-data-refresh", "45 7 * * 1-5", async () => {
    logger.info("Pre-market: refreshing NSE free data feeds");
    await refreshNSEFreeData();
  });

  // ── 08:30 + 09:05 IST Mon–Fri — overnight gap risk (ES=F, USDINR, Nifty) ─
  scheduleJob("gap-risk-refresh", "30 8 * * 1-5", async () => {
    logger.info("Pre-market: refreshing overnight gap risk");
    await fetchGapRisk();
  });
  scheduleJob("gap-risk-refresh-preopen", "5 9 * * 1-5", async () => {
    logger.info("Pre-open: final gap risk refresh");
    await fetchGapRisk();
  });

  // ── 08:00 IST (02:30 UTC) Mon–Fri — daily reset ──────────────────────────
  scheduleJob("daily-reset", "0 8 * * 1-5", () => {
    logger.info("Pre-market: resetting daily state");

    updateMarketOpenStatus();
    updateMarketState({ suggestionsPaused: false, pauseReason: null });

    broadcast({
      event: "system_alert",
      data: {
        message:
          "Good morning. Market opens at 09:15 IST. Running pre-market analysis...",
      },
    });
  });

  // ── 09:12 IST (03:42 UTC) Mon–Fri — gap scan ─────────────────────────────
  scheduleJob("gap-scan", "12 9 * * 1-5", async () => {
    logger.info("Pre-market: starting gap scan");
    await runGapScan();

    broadcast({
      event: "system_alert",
      data: {
        message:
          "Pre-market gap scan complete. Check today's watchlist for gap plays.",
      },
    });
  });



  // ── 09:10 IST (03:40 UTC) Mon–Fri — market opens in 5 min ───────────────
  scheduleJob("market-open-warning", "10 9 * * 1-5", () => {
    logger.info("Market opens in 5 minutes");
    broadcast({
      event: "system_alert",
      data: {
        message:
          "Market opens in 5 minutes. Signals will activate at 09:15 IST.",
      },
    });
  });

  // ── MARKET OPEN: 09:15 IST (03:45 UTC) Mon–Fri ───────────────────────────
  // HIGH FIX (Issue #10): Use distributed lock for critical market-open job
  scheduleJob("market-open", "15 9 * * 1-5", async () => {
    // Use distributed lock to ensure only one instance handles market open
    await runExclusive("market-open-handler", async () => {
      if (marketOpenRetryTimer) {
        clearInterval(marketOpenRetryTimer);
        marketOpenRetryTimer = null;
      }

      const offhoursStatus = getOffHoursScanStatus();
      if (!offhoursStatus.running) {
        await beginMarketOpenMonitoring();
        return;
      }

    logger.warn(
      "Market open delayed: pre-market analysis still running; waiting for completion before enabling live monitoring",
    );
    broadcast({
      event: "system_alert",
      data: {
        message:
          "Market opened, but pre-market analysis is still finishing. Live monitoring will auto-start when scan completes.",
        severity: "warning",
      },
    });

    let attempts = 0;
    marketOpenRetryTimer = setInterval(() => {
      attempts += 1;
      const status = getOffHoursScanStatus();
      if (!status.running) {
        if (marketOpenRetryTimer) {
          clearInterval(marketOpenRetryTimer);
          marketOpenRetryTimer = null;
        }
        void runExclusive("market-open-delayed-start", async () => {
          await beginMarketOpenMonitoring();
        });
        return;
      }
      // Removed max attempts timeout block as per user request to wait indefinitely
    }, MARKET_OPEN_SCAN_WAIT_MS);
    }, true); // Use distributed lock
  });

  // ── MARKET CLOSE: 15:30 IST (10:00 UTC) Mon–Fri ───────────────────────────
  // Stop tick feeder and monitoring
  scheduleJob("market-close", "30 15 * * 1-5", async () => {
    logger.info("Market closed: stopping tick feeder and intraday monitoring");

    // Stop monitoring loop
    if (intradayMonitoringTimer) {
      clearTimeout(intradayMonitoringTimer);
      intradayMonitoringTimer = null;
    }
    if (marketOpenRetryTimer) {
      clearInterval(marketOpenRetryTimer);
      marketOpenRetryTimer = null;
    }

    stopMonitoring();
    stopTickFeeder();
    marketIntelligence.stop();

    broadcast({
      event: "system_alert",
      data: {
        message:
          "Market closed. Tick-by-tick monitoring stopped. Starting post-market analysis...",
      },
    });
  });

  // ── POST-MARKET: 15:31 IST (10:01 UTC) Mon–Fri — Full NSE scan ────────────
  // Comprehensive scan of entire NSE universe to find tomorrow's best setups
  // Runs thoroughly without rushing - takes 30-45 minutes to analyze all stocks
  scheduleJob("post-market-full-scan", "31 15 * * 1-5", async () => {
    const offhoursStatus = getOffHoursScanStatus();
    if (offhoursStatus.running) {
      logger.warn(
        "Post-market full scan skipped because off-hours scan is already running",
      );
      return;
    }

    logger.info("Post-market: Starting full NSE universe scan for tomorrow");

    try {
      const candidates = await runPostMarketFullScan();

      logger.info(
        {
          candidatesFound: candidates.length,
          top5: candidates
            .slice(0, 5)
            .map((c) => `${c.symbol}(${c.probability.toFixed(0)}%)`),
        },
        "Post-market full scan completed",
      );

      broadcast({
        event: "system_alert",
        data: {
          message: `Post-market scan complete: Found ${candidates.length} high-probability setups for tomorrow. Check watchlist!`,
          severity: "info",
        },
      });
    } catch (err) {
      logger.error({ err }, "Post-market full scan failed");
      broadcast({
        event: "system_alert",
        data: {
          message: "Post-market scan failed. Check logs for details.",
          severity: "error",
        },
      });
    }
  });

  // ── POST-MARKET: 15:35 IST (10:05 UTC) Mon–Fri — expire intraday ─────────
  scheduleJob("expire-intraday", "35 15 * * 1-5", async () => {
    logger.info("Post-market: expiring today's intraday signals");
    await expireTodayIntraday();
  });

  // ── POST-MARKET: 15:45 IST Mon-Fri - run main overnight scanner ONCE ──
  scheduleJob("overnight-scanner-post-market", "45 15 * * 1-5", async () => {
    logger.info("Post-market: running overnight scanner");
    await runOvernightScanner(false, false, "scheduler");
  });

  // ── POST-MARKET: 15:50 IST (10:20 UTC) Mon–Fri — save day stats ──────────
  scheduleJob("save-post-market-data", "50 15 * * 1-5", async () => {
    logger.info("Post-market: saving performance stats and market metrics");
    await savePostMarketData();
  });

  // ── POST-MARKET: 16:00 IST (10:30 UTC) Mon–Fri — run continuous learning pipeline ──
  scheduleJob("continuous-learning", "0 16 * * 1-5", async () => {
    logger.info("Post-market: running continuous learning pipeline");
    await runLearningPipeline();
  });

  // ── POST-MARKET: 16:05 IST Mon–Fri — outcome calibration refresh ─────────
  // Rebuild the empirical confidence table daily; re-evaluate walk-forward
  // setup demotions weekly (Friday) once the week's outcomes are booked.
  scheduleJob("calibration-refresh", "5 16 * * 1-5", async () => {
    logger.info("Post-market: refreshing confidence calibration from outcomes");
    await refreshCalibration();
  });

  scheduleJob("setup-demotion-check", "10 16 * * 5", async () => {
    logger.info("Weekly: walk-forward setup expectancy check");
    const demoted = await refreshSetupDemotions();
    if (demoted.size > 0) {
      logger.warn({ setups: Array.from(demoted) }, "Setups currently demoted by rolling expectancy");
    }
  });

  // ── POST-MARKET: 16:15 IST (10:45 UTC) Mon–Fri — generate daily report ──
  scheduleJob("generate-daily-report", "15 16 * * 1-5", async () => {
    const { generateDailyReport } = await import("../analysis/post_market_report");
    logger.info("Post-market: generating daily report");
    await generateDailyReport();
  });



  // ── MIDNIGHT IST (18:30 UTC) daily — cleanup + reset ─────────────────────
  // Runs every day: midnight after Friday's session is SATURDAY (dow 6), so a
  // 1-5 restriction would leave Friday's leftovers un-expired all weekend.
  scheduleJob("midnight-cleanup", "0 0 * * *", async () => {
    logger.info(
      "Midnight cleanup: expiring old suggestions, resetting market feed cache",
    );
    await expireOldSuggestions();
    resetMarketFeedCache();
  });

  scheduleJob("alpha-score-ic-monitor", "0 6 * * 6", async () => {
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const path = await import("path");
      const { fileURLToPath } = await import("url");
      const execAsync = promisify(exec);
      logger.info("Running weekly Alpha Score IC recalculation");
      const moduleDir = path.dirname(fileURLToPath(import.meta.url));
      const scriptPath = path.resolve(moduleDir, "../../ai_service/backtest/run_weekly_ic.py");
      const { stdout, stderr } = await execAsync(`python "${scriptPath}"`);
      logger.info({ stdout, stderr }, "Weekly IC recalculation completed");
    } catch (err) {
      logger.error({ err }, "Weekly IC recalculation failed");
    }
  });

  // Register callback to dynamically hot-reload/swap monitored stocks if overnight/mid-day scan completes mid-session.
  registerOnScanCompleted(async () => {
    try {
      await syncMonitoredSubscriptions();
    } catch (err) {
      logger.error({ err }, "Failed to sync monitored subscriptions after scan");
    }
    if (isMarketOpen()) {
      logger.info(
        "Scan completed during market hours — refreshing monitored stocks without restarting full open pipeline",
      );
      try {
        await initIntradayMonitoring();
        if (!getMonitoringStatus().active) {
          startMonitoring();
        }
        broadcast({
          event: "system_alert",
          data: {
            message: "Watchlist updated. Monitored stocks refreshed for live session.",
            severity: "info",
          },
        });
      } catch (err) {
        logger.error({ err }, "Failed to refresh monitored stocks mid-session");
      }
    }
  });

  // ── Initial state ─────────────────────────────────────────────────────────
  updateMarketOpenStatus();
  detectRegime();

  const phase = computeSessionPhase();
  logger.info({ phase }, "Scheduler started");

  // Expire old intraday suggestions from previous days just in case the bot was offline at midnight
  void expireOldSuggestions();

  // Prime outcome-derived state so the first generation cycle isn't uncalibrated
  void refreshCalibration();
  void refreshSetupDemotions();
  void refreshNSEFreeData();

  if (!isMarketOpen()) {
    runExclusive("startup-market-feed-offhours", async () => {
      const tomorrow = getNextTradingDayStr();
      const alreadyScanned = await getSuccessfulScanForDate("OFFHOURS_SCAN", tomorrow);
      
      if (!alreadyScanned) {
        logger.info(`Off-hours startup: running initial overnight scan for ${tomorrow}`);
        runOvernightScanner(false, false, "startup").catch((err) =>
          logger.error({ err }, "Initial overnight scan failed"),
        );
      } else {
        logger.info(`Off-hours startup: already have scan candidates for ${tomorrow}, skipping.`);
      }

      await initMarketFeed();
      await updateMarketFeed();
    }).catch((err) => logger.error({ err }, "Off-hours startup market-feed failed"));
  } else {
    logger.info(
      "Market-hours startup: priming feed, launching tick feeder and live monitoring",
    );
    runExclusive("startup-market-feed", async () => {
      // Check if a scan has already been executed for today
      const today = getISTDateStr();
      const alreadyScanned = await getSuccessfulScanForDate("OFFHOURS_SCAN", today);

      if (!alreadyScanned) {
        logger.warn(
          `No overnight scan candidates found for today (${today}). Running a background scan to select stock candidates.`,
        );
        // Start monitoring using fallback universe immediately so tick feeder and index sync don't starve
        await beginMarketOpenMonitoring();
        
        // Trigger overnight/mid-day scan in background. Since tomorrowStr will resolve to "today" 
        // because we are before market close of today, this will populate today's watchlist.
        // Once completed, our registerOnScanCompleted callback will automatically swap in the real stocks!
        runOvernightScanner(false, false, "startup").catch((err) =>
          logger.error({ err }, "Startup background mid-day scan failed"),
        );
      } else {
        logger.info(`Overnight scan candidates exist for today (${today}). Initializing monitoring immediately.`);
        await beginMarketOpenMonitoring();
      }
    }).catch((err) => logger.error({ err }, "Startup market open monitoring failed"));
  }
}
