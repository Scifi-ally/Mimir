import cron from "node-cron";
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

const SCHEDULER_TIMEZONE = "Asia/Kolkata";
let schedulerRunning = false;
const runningJobs = new Set<string>();
let marketFeedRealtimeTimer: ReturnType<typeof setInterval> | null = null;
let intradayMonitoringTimer: ReturnType<typeof setTimeout> | null = null;
let marketOpenRetryTimer: ReturnType<typeof setInterval> | null = null;
const ENABLE_INTRADAY_WATCHLIST_ENRICHMENT =
  (process.env["ENABLE_INTRADAY_WATCHLIST_ENRICHMENT"] ?? "true").toLowerCase() === "true";
const MONITORING_INTERVAL_MS = 300; // Run monitoring cycle every 300ms during market hours
const MARKET_OPEN_SCAN_WAIT_MS = 60_000;
const MARKET_OPEN_SCAN_MAX_ATTEMPTS = 20;
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

  async function scheduleNextMonitoringCycle() {
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
      const elapsed = Date.now() - startTime;
      const delay = Math.max(10, MONITORING_INTERVAL_MS - elapsed);
      intradayMonitoringTimer = setTimeout(() => {
        void scheduleNextMonitoringCycle();
      }, delay);
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

async function runExclusive(
  name: string,
  task: () => void | Promise<void>,
): Promise<void> {
  if (runningJobs.has(name)) {
    logger.warn(
      { job: name },
      "Skipping scheduler job because previous run is still active",
    );
    return;
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
  }
}

function scheduleJob(
  name: string,
  expression: string,
  task: () => void | Promise<void>,
): void {
  cron.schedule(expression, () => void runExclusive(name, task), {
    timezone: SCHEDULER_TIMEZONE,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function updateDailyLoss(): Promise<void> {
  try {
    const rows = await db
      .select({ pnlInr: suggestionsTable.pnlInr })
      .from(suggestionsTable)
      .where(
        and(
          gte(suggestionsTable.generatedAt, todayStartUTC()),
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
      .where(gte(suggestionsTable.generatedAt, weekStart));
    const weeklyPnl = weeklyRows.reduce((sum, r) => {
      const v = r.pnlInr != null ? parseFloat(r.pnlInr) : 0;
      return sum + v;
    }, 0);
    const weeklyLossLimit = cfg.tradingCapital * (cfg.weeklyLossLimitPct / 100);
    const weeklyLimitHit = Math.abs(Math.min(weeklyPnl, 0)) >= weeklyLossLimit;

    const rollingRows = await db
      .select({ pnlInr: suggestionsTable.pnlInr, status: suggestionsTable.status })
      .from(suggestionsTable)
      .where(gte(suggestionsTable.generatedAt, weekStart));
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

async function runStateReconciliation(): Promise<void> {
  const config = getConfig();
  if (config.paperTradingEnabled) return; // Only applicable for live trading reconciliation

  try {
    // Fetch live positions from Upstox (aborting safely if getPositions is unimplemented rather than mocking 0 positions)
    logger.debug("State reconciliation skipped — getPositions not implemented yet");
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
  cron.schedule("*/5 9-15 * * 1-5", () => {
    void runExclusive("macro-data-fetch", async () => {
      logger.info("Fetching global macro & options sentiment data...");
      await fetchGlobalMacroData();
      await fetchOptionsSentimentData();
    });
  }, { timezone: SCHEDULER_TIMEZONE });

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

  // ── Every 5 min during market hours: update Nifty + VIX, detect regime ───
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

  // ── Every 5 min during market hours: check suggestion outcomes ────────────
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

  // ── EVERY 45 min DURING MARKET HOURS: enrich watchlist with intraday opps ──
  // Adds new high-confidence intraday setups to the watchlist as they develop
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
    try {
      const { evaluateCustomScreenerSchedules } = await import("./custom_screener_scheduler");
      await evaluateCustomScreenerSchedules();
    } catch (err) {
      logger.error({ err }, "Failed to evaluate custom screener schedules");
    }
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

  // ── 08:45 IST (03:15 UTC) Mon–Fri — gap scan ─────────────────────────────
  scheduleJob("gap-scan", "45 8 * * 1-5", async () => {
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
  scheduleJob("market-open", "15 9 * * 1-5", async () => {
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
      if (attempts >= MARKET_OPEN_SCAN_MAX_ATTEMPTS) {
        if (marketOpenRetryTimer) {
          clearInterval(marketOpenRetryTimer);
          marketOpenRetryTimer = null;
        }
        logger.error(
          { attempts },
          "Market-open delayed start timed out while pre-market scan was still running; starting monitoring with available data",
        );
        void runExclusive("market-open-timeout-start", async () => {
          await beginMarketOpenMonitoring();
        });
        broadcast({
          event: "system_alert",
          data: {
            message:
              "Pre-market scan timed out. Live monitoring started with the best available watchlist.",
            severity: "warning",
          },
        });
      }
    }, MARKET_OPEN_SCAN_WAIT_MS);
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
  scheduleJob("post-market-full-scan", "31 15 * * 0-5", async () => {
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



  // ── MIDNIGHT IST (18:30 UTC) Mon–Fri — cleanup + reset ───────────────────
  scheduleJob("midnight-cleanup", "0 0 * * 1-5", async () => {
    logger.info(
      "Midnight cleanup: expiring old suggestions, resetting market feed cache",
    );
    await expireOldSuggestions();
    resetMarketFeedCache();
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
