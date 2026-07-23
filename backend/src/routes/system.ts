import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { db, suggestionsTable } from "../../db/src";
import { inArray } from "drizzle-orm";
import {
  isAuthenticated,
  isDirectlyAuthenticated,
  getAuthorizationUrl,
  getTokenExpiryInfo,
  getDirectTokenExpiryInfo,
  getAccessToken,
  exchangeCodeForToken,
} from "../upstox/auth";
import { getConfig } from "../config";
import {
  getMarketState,
  isMarketOpen,
  computeSessionPhase,
  computeDashboardSession,
  minutesUntilOpen,
  formatMinutesAsCountdown,
} from "../market_data/market_state";
import { getMarketFeedSnapshot } from "../market_data/market_feed";
import { upstoxConnectionManager } from "../intelligence/connection_manager";
import { upstoxHeadlessAuth } from "../upstox/headless_auth";
import { getEffectiveUniverse } from "../analysis/stock_scanner";
import { getConnectedClients, broadcast } from "../ws/websocket_server";
import { isSchedulerRunning } from "../scheduler/jobs";
import {
  getOffHoursScanStatus,
  runOvernightScanner,
  getActiveScanSessionId,
  abortOvernightScanner,
} from "../analysis/overnight_scanner";
import { runPostMarketFullScan, abortPostMarketFullScan } from "../analysis/post_market_scanner";
import {
  generateSuggestionsFromWatchlist,
  getSuggestionGenerationDiagnostics,
} from "../suggestions/generator";
import { getScannerState } from "../analysis/post_market_scanner";
import { getMonitoringStatus, MONITORING_MAX_STOCKS } from "../analysis/intraday_monitor";
import { HandleAuthCallbackQueryParams } from "../schemas";
import { logger } from "../lib/logger";
import { checkDbConnection, getDailyStats, getCalibrationReport } from "../services/system_stats";
import { getWorkflowStatus, resetActiveWorkflow } from "../workflow/coordinator";
import { checkAIHealth } from "../analysis/ai_client";
import {
  getMarketIntelligenceSnapshot,
  getMarketIntelligenceSuggestions,
} from "../intelligence/orchestrator";
import { getWorkerPoolStats } from "../intelligence/worker_pool";
import {
  addManualMonitoredSymbol,
  removeManualMonitoredSymbol,
  getCachedWatchlistDate,
  getManualSymbols,
  getMonitoredSubscriptionStocks,
} from "../market_data/monitored_symbols";
import { getAllCalibrations, getDemotedSetups } from "../analysis/calibration_engine";

const router = Router();
const AUTH_STATE_COOKIE = "upstox_auth_state";

function getUnifiedScanStatus() {
  const offhours = getOffHoursScanStatus();
  const generation = getSuggestionGenerationDiagnostics();
  const postMarket = getScannerState();
  const running = offhours.running || generation.running || postMarket.running;
  const mode = generation.running
    ? "intraday-suggestions"
    : postMarket.running
      ? "post-market-scan"
    : offhours.running
      ? "offhours-watchlist"
      : "idle";
  const lastScanMessage = generation.running
    ? generation.note ?? "Generating high-quality suggestions..."
    : postMarket.running
      ? postMarket.lastMessage ?? "Post-market full NSE scan running..."
    : offhours.running
      ? offhours.lastScanMessage ?? "Off-hours scan running..."
      : offhours.lastScanMessage ?? postMarket.lastMessage ?? generation.note ?? "Idle";

  return {
    running,
    mode,
    scanSessionId: getActiveScanSessionId(),
    lastScanStatus: postMarket.running
      ? postMarket.lastStatus
      : offhours.lastScanStatus !== "idle"
        ? offhours.lastScanStatus
        : postMarket.lastStatus,
    lastScanMessage,
    offhours,
    postMarket,
    generation,
    workflow: getWorkflowStatus(),
  };
}


// GET /api/system/status
router.get("/system/status", async (_req, res) => {
  const state = getMarketState();
  const cfg = getConfig();
  const feed = getMarketFeedSnapshot();
  const effectiveUniverse = await getEffectiveUniverse();
  const generation = getSuggestionGenerationDiagnostics();
  const aiHealth = await checkAIHealth();

  // Real DB connectivity check
  const dbConnected = await checkDbConnection();
  const stats = await getDailyStats();
  
  const dailyLossToday = stats.dailyLossToday;
  const signalsGenerated = stats.signalsGenerated;
  const averageConfidence = stats.averageConfidence;
  const averageRiskReward = stats.averageRiskReward;
  
  const candidatesScanned = generation.eligibleCandidates || 0;
  const candidatesQualified = generation.generated;
  const candidatesRejected = Object.values(generation.rejectionCounts ?? {}).reduce((sum, value) => sum + value, 0);
  const avgScanDurationMs = generation.averageDurationMs ?? generation.lastDurationMs ?? 0;

  const aiMode = aiHealth.ai_mode ?? (aiHealth.status === "healthy" ? "AI Mode" : "Fallback Mode");
  const rankingProvider = aiHealth.ranking_provider ?? (aiHealth.status === "healthy" ? "AI Ranking" : "Technical Ranking");
  const confidenceLabel = aiMode === "AI Mode" ? "Average Opportunity Score" : "Average Composite Score";

  const opportunityQualityGrade =
    averageConfidence == null || averageRiskReward == null
      ? "N/A"
      : averageConfidence >= 85 && averageRiskReward >= 2.0
        ? "A"
        : averageConfidence >= 75 && averageRiskReward >= 1.7
          ? "B"
          : "C";

  res.json({
    wsConnected: getConnectedClients() > 0,
    dbConnected,
    schedulerRunning: isSchedulerRunning(),
    upstoxAuthenticated: isAuthenticated(),
    upstoxFeedAuthenticated: isDirectlyAuthenticated("trading"),
    upstoxDataAuthenticated: isDirectlyAuthenticated("data"),
    upstoxConfigured: Boolean((cfg.upstoxApiKey && cfg.upstoxApiSecret) || (cfg.upstoxDataApiKey && cfg.upstoxDataApiSecret)),
    upstoxFeedConfigured: Boolean(cfg.upstoxApiKey && cfg.upstoxApiSecret),
    upstoxDataConfigured: Boolean(cfg.upstoxDataApiKey && cfg.upstoxDataApiSecret),
    useDualApiKeys: cfg.useDualApiKeys,
    isMarketOpen: isMarketOpen(), // Dynamically compute instead of relying on decoupled local state
    symbolsCached: effectiveUniverse.length, // Renamed from instrumentsLoaded (Issue #9)
    activeSubscriptions:
      feed.status === "ready" || feed.status === "partial" ? 2 : 0,
    lastTickAt: feed.fetchedAt,
    dailyLossToday: Math.abs(Math.round(dailyLossToday * 100) / 100),
    dailyLossLimitHit:
      dailyLossToday < 0 &&
      Math.abs(dailyLossToday) >=
        cfg.tradingCapital * (cfg.maxDailyLossPct / 100),
    monitoringMaxStocks: MONITORING_MAX_STOCKS,
    aiStatus: aiHealth.status,
    aiMode,
    rankingProvider,
    aiDetails: aiHealth,

    // Rich session metrics (Issue #8)
    signalsGenerated,
    candidatesScanned,
    candidatesQualified,
    candidatesRejected,
    avgConfidence: averageConfidence,
    avgConfidenceLabel: confidenceLabel,
    avgAiConfidence: aiMode === "AI Mode" ? averageConfidence : null,
    avgRr: averageRiskReward,
    avgScanDurationMs,
    currentMarketRegime: state.regime,
    opportunityQualityGrade,
    upstoxTokenExpiry: getTokenExpiryInfo(),
    upstoxFeedTokenExpiry: getDirectTokenExpiryInfo("trading"),
    upstoxDataTokenExpiry: getDirectTokenExpiryInfo("data"),
  });
});

// GET /api/system/session-state — dashboard session (server IST schedule)
router.get("/system/session-state", (_req, res) => {
  const session = computeDashboardSession();
  const phase = computeSessionPhase();
  const minsUntilOpen = minutesUntilOpen();
  const scanStatus = getUnifiedScanStatus();

  res.json({
    session,
    phase,
    isMarketOpen: phase === "MARKET",
    minutesUntilOpen: minsUntilOpen,
    opensIn: formatMinutesAsCountdown(minsUntilOpen),
    marketOpenTime: "09:15",
    marketCloseTime: "15:30",
    postMarketScanWindow: "15:31–16:15",
    scanRunning: scanStatus.running,
    scanMode: scanStatus.mode,
    scanMessage: scanStatus.lastScanMessage,
    scanProgress: {
      current: scanStatus.mode === "post-market-scan" ? ((scanStatus.postMarket as { currentProgress?: number }).currentProgress ?? 0) :
               scanStatus.mode === "offhours-watchlist" ? ((scanStatus.offhours as { currentProgress?: number }).currentProgress ?? 0) :
               ((scanStatus.generation as { currentProgress?: number }).currentProgress ?? 0),
      total: scanStatus.mode === "post-market-scan" ? ((scanStatus.postMarket as { eligibleCandidates?: number }).eligibleCandidates ?? 0) :
             scanStatus.mode === "offhours-watchlist" ? ((scanStatus.offhours as { eligibleCandidates?: number }).eligibleCandidates ?? 0) :
             ((scanStatus.generation as { eligibleCandidates?: number }).eligibleCandidates ?? 0),
    },
    updatedAt: new Date().toISOString(),
  });
});

// GET /api/system/intraday-monitoring
router.get("/system/intraday-monitoring", (_req, res) => {
  res.json(getMonitoringStatus());
});

// GET /api/system/calibration — predicted confidence vs realized win rate per setup.
// Shows which setups are over-confident (predicted >> realized) and should be cut.
router.get("/system/calibration", async (req, res) => {
  try {
    const lookbackDays = Math.min(Number(req.query.days) || 90, 365);
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const setups = await getCalibrationReport(since);

    res.json({
      lookbackDays,
      setups,
      // Live blend table used by the generator (setup×tradeType win rates + MFE/MAE)
      activeCalibrations: getAllCalibrations(),
      demotedSetups: getDemotedSetups(),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Calibration report failed");
    res.status(500).json({ error: "Calibration report failed" });
  }
});

// GET /api/system/monitored-symbols
router.get("/system/monitored-symbols", async (_req, res) => {
  try {
    const stocks = await getMonitoredSubscriptionStocks();
    const scanStatus = getUnifiedScanStatus();
    res.json({
      symbols: stocks.map((s) => s.symbol),
      stocks,
      manualSymbols: getManualSymbols(),
      watchlistDate: getCachedWatchlistDate(),
      scanRunning: scanStatus.running,
      scanMode: scanStatus.mode,
      maxStocks: MONITORING_MAX_STOCKS,
    });
  } catch (err) {
    logger.error({ err }, "Failed to get monitored symbols");
    res.status(500).json({ error: "Failed to get monitored symbols" });
  }
});

// POST /api/system/monitored-symbols — add symbol to manual monitored set
router.post("/system/monitored-symbols", async (req, res) => {
  const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  try {
    const added = await addManualMonitoredSymbol(symbol);
    if (!added) {
      res.status(404).json({ error: `Symbol ${symbol} not found in universe` });
      return;
    }
    const stocks = await getMonitoredSubscriptionStocks();
    res.json({ success: true, symbol: added.symbol, stocks: stocks.map((s) => s.symbol) });
  } catch (err) {
    logger.error({ err }, "Failed to add monitored symbol");
    res.status(500).json({ error: "Failed to add monitored symbol" });
  }
});

// DELETE /api/system/monitored-symbols — remove symbol from manual monitored set
router.delete("/system/monitored-symbols", async (req, res) => {
  const symbol = String(req.query.symbol || req.body?.symbol || "").trim().toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  try {
    const removed = await removeManualMonitoredSymbol(symbol);
    if (!removed) {
      res.status(404).json({ error: `Symbol ${symbol} not found in manual monitored list` });
      return;
    }
    const stocks = await getMonitoredSubscriptionStocks();
    res.json({ success: true, symbol, stocks: stocks.map((s) => s.symbol) });
  } catch (err) {
    logger.error({ err }, "Failed to remove monitored symbol");
    res.status(500).json({ error: "Failed to remove monitored symbol" });
  }
});

// GET /api/system/symbols
// Returns symbols from effective universe for quick search and chart launch.
router.get("/system/symbols", async (req, res) => {
  const query = String(req.query.q ?? "").trim().toUpperCase();
  const requestedLimit = Number(req.query.limit ?? "1500");
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 5000)
    : 1500;

  try {
    const baseUniverse = await getEffectiveUniverse();
    const indices = [
      { symbol: "NIFTY 50", name: "Nifty 50 Index", key: "NSE_INDEX|Nifty 50", sector: "INDEX" },
      { symbol: "BANKNIFTY", name: "Nifty Bank Index", key: "NSE_INDEX|Nifty Bank", sector: "INDEX" },
      { symbol: "FINNIFTY", name: "Nifty Fin Service", key: "NSE_INDEX|Nifty Fin Service", sector: "INDEX" },
      { symbol: "SENSEX", name: "Sensex Index", key: "BSE_INDEX|SENSEX", sector: "INDEX" },
      { symbol: "INDIA VIX", name: "India VIX", key: "NSE_INDEX|India VIX", sector: "INDEX" }
    ];
    
    // Combine base universe and indices
    const universe = [...indices, ...baseUniverse];
    
    let filtered = universe;
    if (query) {
      filtered = universe
        .map((s) => {
          const sym = s.symbol.toUpperCase();
          const nm = s.name.toUpperCase();
          let score = 0;
          if (sym === query) score = 100;
          else if (sym.startsWith(query)) score = 80;
          else if (nm.startsWith(query) || nm.includes(` ${query}`)) score = 60;
          else if (sym.includes(query)) score = 40;
          else if (nm.includes(query)) score = 20;
          return { s, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.s.symbol.localeCompare(b.s.symbol))
        .map((item) => item.s);
    }

    const items = filtered
      .slice(0, limit)
      .map((s) => ({
        symbol: s.symbol,
        name: s.name,
        key: s.key,
        sector: s.sector,
      }));

    res.json({
      count: items.length,
      total: filtered.length,
      query,
      items,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to load symbol universe");
    res.status(500).json({ error: "Failed to load symbols" });
  }
});

// GET /api/system/auth-url
router.get("/system/auth-url", (req, res) => {
  const cfg = getConfig();
  const type = req.query.type === "data" ? "data" : "trading";
  
  if (type === "trading" && (!cfg.upstoxApiKey || !cfg.upstoxApiSecret)) {
    res.status(400).json({ url: "", error: "Upstox API key and secret are required" });
    return;
  } else if (type === "data" && (!cfg.upstoxDataApiKey || !cfg.upstoxDataApiSecret)) {
    res.status(400).json({ url: "", error: "Upstox Data API key and secret are required" });
    return;
  }

  const cookieName = `${AUTH_STATE_COOKIE}_${type}`;
  const state = crypto.randomBytes(24).toString("hex") + "_" + type;
  res.cookie(cookieName, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: cfg.upstoxRedirectUri.startsWith("https://"),
    maxAge: 10 * 60 * 1000,
  });

  const url = getAuthorizationUrl(state, type);
  res.json({ url });
});

const HeadlessBeginSchema = z.object({ type: z.enum(["data", "trading"]).optional().default("trading") });

// POST /api/system/headless/begin — reuses saved Upstox session; usually lands
// straight on the PIN step (or completes outright) so phone + OTP are skipped.
router.post("/system/headless/begin", async (req, res) => {
  const cfg = getConfig();
  const parsed = HeadlessBeginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
    return;
  }
  const type = parsed.data.type;

  if (type === "trading" && (!cfg.upstoxApiKey || !cfg.upstoxApiSecret)) {
    res.status(400).json({ error: "Upstox API key and secret are required" });
    return;
  } else if (type === "data" && (!cfg.upstoxDataApiKey || !cfg.upstoxDataApiSecret)) {
    res.status(400).json({ error: "Upstox Data API key and secret are required" });
    return;
  }

  try {
    const result = await upstoxHeadlessAuth.begin(type);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to start authorization" });
  }
});

const HeadlessPhoneSchema = z.object({ 
  type: z.enum(["data", "trading"]).optional().default("trading"), 
  phone: z.string().min(1, "Phone number is required") 
});

// POST /api/system/headless/phone
router.post("/system/headless/phone", async (req, res) => {
  const cfg = getConfig();
  const parsed = HeadlessPhoneSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
    return;
  }
  const { type, phone } = parsed.data;

  if (type === "trading" && (!cfg.upstoxApiKey || !cfg.upstoxApiSecret)) {
    res.status(400).json({ error: "Upstox API key and secret are required" });
    return;
  }

  try {
    // If begin() already opened the login page, just type into it; otherwise
    // fall back to launching a fresh session (old flow).
    const result = await upstoxHeadlessAuth.submitPhone(phone).catch(async () =>
      upstoxHeadlessAuth.start(type, phone)
    );
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to start phone verification" });
  }
});

const HeadlessOtpSchema = z.object({ otp: z.string().min(1, "OTP is required") });

// POST /api/system/headless/otp
router.post("/system/headless/otp", async (req, res) => {
  const parsed = HeadlessOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
    return;
  }
  const { otp } = parsed.data;
  try {
    const result = await upstoxHeadlessAuth.submitOTP(otp);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to submit OTP" });
  }
});

const HeadlessPinSchema = z.object({ pin: z.string().min(1, "PIN is required") });

// POST /api/system/headless/pin
router.post("/system/headless/pin", async (req, res) => {
  const parsed = HeadlessPinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
    return;
  }
  const { pin } = parsed.data;
  try {
    const result = await upstoxHeadlessAuth.submitPIN(pin);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to submit PIN" });
  }
});

// POST /api/system/headless/cancel
router.post("/system/headless/cancel", async (_req, res) => {
  try {
    await upstoxHeadlessAuth.cleanup();
  } catch (err) {
    logger.error({ err }, "Headless cleanup error (non-fatal)");
  }
  res.json({ status: "cancelled" });
});

// GET /api/system/offhours-scan
router.get("/system/offhours-scan", (_req, res) => {
  res.json(getUnifiedScanStatus());
});

// GET /api/system/scan-observability
router.get("/system/scan-observability", (_req, res) => {
  const status = getUnifiedScanStatus();
  res.json({
    running: status.running,
    lastScanStatus: status.lastScanStatus,
    lastScanMessage: status.lastScanMessage,
    dataTelemetry: status.offhours.dataTelemetry,
    observability: status.offhours.observability ?? null,
    generation: status.generation,
  });
});

// GET /api/system/suggestion-diagnostics
router.get("/system/suggestion-diagnostics", (_req, res) => {
  res.json(getSuggestionGenerationDiagnostics());
});

router.get("/system/market-intelligence", (_req, res) => {
  res.json({
    snapshot: getMarketIntelligenceSnapshot(),
    workerPools: getWorkerPoolStats(),
    suggestions: getMarketIntelligenceSuggestions(),
  });
});

async function runManualScannerPipeline(options: {
  testMode: boolean;
  forceReset: boolean;
  scanSessionId?: string;
}) {
  const startedAt = Date.now();
  try {
    await runOvernightScanner(
      options.testMode,
      options.forceReset,
      "manual",
      options.scanSessionId,
    );

    const offhoursStatus = getOffHoursScanStatus();
    if (offhoursStatus.lastScanStatus !== "success") {
      broadcast({
        event: "system_alert",
        data: {
          message: `Suggestion generation skipped because the market scan ended with ${offhoursStatus.lastScanStatus ?? "an unknown"} status.`,
          severity: offhoursStatus.lastScanStatus === "stopped" ? "warning" : "error",
        },
      });
      return;
    }

    await generateSuggestionsFromWatchlist({
      bypassTimingFilter: true,
      source: "manual",
      scanSessionId: options.scanSessionId,
    });
  } catch (err) {
    reqLogSafe("Manual scanner pipeline failed", err);
    broadcast({
      event: "system_alert",
      data: {
        message: "Manual scanner failed. Check backend logs.",
        severity: "error",
      },
    });
  } finally {
    logger.info({ duration: Date.now() - startedAt, scanSessionId: options.scanSessionId }, "Manual scanner flow finished");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reqLogSafe(message: string, err: any) {
  // Keeps background pipeline logging available without holding the HTTP request object.
  logger.error({ err }, message);
}

// POST /api/system/post-market-scanner
// Manually trigger the market-wide post-close scan.
router.post("/system/post-market-scanner", (_req, res) => {
  if (isMarketOpen()) {
    res.status(409).json({
      started: false,
      mode: "post-market-scanner",
      error: "Post-market full scan can only run after market close.",
      status: getUnifiedScanStatus(),
    });
    return;
  }

  const offhoursStatus = getOffHoursScanStatus();
  if (offhoursStatus.running) {
    res.status(409).json({
      started: false,
      mode: "post-market-scanner",
      error: "Off-hours scan already running. Wait for completion.",
      status: getUnifiedScanStatus(),
    });
    return;
  }

  const preState = getScannerState();
  if (preState.running) {
    res.status(202).json({
      started: false,
      mode: "post-market-scanner",
      running: true,
      lastScanMessage: "Full market scan already running",
      stocksToAnalyze: preState.totalStocks,
      status: preState,
    });
    return;
  }

  void runPostMarketFullScan("manual");
  const state = getScannerState();
  res.status(202).json({
    started: true,
    mode: "post-market-scanner",
    running: state.running,
    lastScanMessage: state.running ? "Full market scan running..." : "Queued full market scan",
    stocksToAnalyze: state.totalStocks,
    status: state,
  });
});

// POST /api/system/offhours-scan/stop
router.post("/system/offhours-scan/stop", (_req, res) => {
  const aborted = abortOvernightScanner() || abortPostMarketFullScan();
  if (aborted) {
    res.json({ message: "Scan stopping...", status: getUnifiedScanStatus() });
  } else {
    res.json({ message: "No scan currently running.", status: getUnifiedScanStatus() });
  }
});

const OffhoursScanSchema = z.object({
  test: z.boolean().optional(),
  force: z.boolean().optional(),
  forceSuggestions: z.boolean().optional(),
  scanSessionId: z.string().optional()
});

// POST /api/system/offhours-scan
router.post("/system/offhours-scan", async (req, res) => {
  const bodyParsed = OffhoursScanSchema.safeParse(req.body || {});
  const body = bodyParsed.success ? bodyParsed.data : {};
  
  const testMode = req.query.test === "true" || Boolean(body.test);
  const forceReset = req.query.force === "true" || Boolean(body.force);
  const forceSuggestions = req.query.forceSuggestions === "true" || Boolean(body.forceSuggestions);

  if (forceSuggestions) {
    if (!getAccessToken()) {
      res.status(401).json({
        error: "Upstox authentication required",
        message: "Force suggestion scans require a live Upstox token. Mock market data is disabled.",
      });
      return;
    }
    resetActiveWorkflow();
  }

  const currentStatus = getUnifiedScanStatus();
  if (currentStatus.running && !forceReset) {
    res.status(202).json({
      started: false,
      mode: currentStatus.mode,
      alreadyRunning: true,
      status: currentStatus,
    });
    return;
  }

  if (isMarketOpen() || forceSuggestions) {
    if (!isAuthenticated() && !forceSuggestions) {
      res.status(409).json({
        started: false,
        mode: "intraday-suggestions",
        error: "Upstox authentication required before intraday generation can run.",
      });
      return;
    }

    const scanSessionId =
      (req.query.scanSessionId as string) ||
      body.scanSessionId ||
      crypto.randomUUID();

    if (forceReset) {
      try {
        await db.delete(suggestionsTable).where(inArray(suggestionsTable.status, ["ACTIVE", "PENDING"]));
      } catch (err) {
        req.log.error({ err }, "Failed to clear active suggestions before forced scan");
      }
    }

    void runManualScannerPipeline({
      testMode,
      forceReset,
      scanSessionId,
    });
    res.status(202).json({
      started: true,
      mode: "market-scanner-pipeline",
      scanSessionId,
      status: getUnifiedScanStatus(),
    });
    return;
  }

  if (!isAuthenticated()) {
    res.status(409).json({
      started: false,
      mode: "offhours-watchlist",
      error: "Upstox authentication required before off-hours scan can run.",
    });
    return;
  }

  const scanSessionId =
    (req.query.scanSessionId as string) ||
    body.scanSessionId ||
    crypto.randomUUID();

  void runManualScannerPipeline({ testMode, forceReset, scanSessionId });
  res.status(202).json({
    started: true,
    mode: "offhours-watchlist",
    testMode,
    scanSessionId,
    status: getUnifiedScanStatus(),
  });
});

const htmlResponse = (title: string, message: string, isError = false) => {
  const signalColor = isError ? "#FF3B3B" : "#1FCB6E";
  const badgeText = isError ? "FAIL" : "OK";
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        body {
          font-family: "IBM Plex Mono", "JetBrains Mono", monospace;
          background-color: #000000;
          color: #F2F2F2;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
          box-sizing: border-box;
        }
        .container {
          text-align: center;
          max-width: 440px;
          padding: 32px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
        }
        .label {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.15em;
          color: #7A7A7E;
          opacity: 0.5;
        }
        h2 {
          color: ${signalColor};
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        p {
          color: #7A7A7E;
          font-size: 12px;
          line-height: 1.6;
          margin: 0;
        }
        .status-chip {
          display: inline-block;
          margin-top: 16px;
          padding: 4px 8px;
          border: 1px solid ${signalColor}33;
          background-color: ${signalColor}08;
          color: ${signalColor};
          font-size: 10px;
          font-weight: bold;
          text-transform: uppercase;
          letter-spacing: 0.1em;
        }
        .close-instruction {
          font-size: 10px;
          color: #4A4A4D;
          margin-top: 8px;
          text-transform: uppercase;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <span class="label">System Authorization</span>
        <h2>${title}</h2>
        <p>${message}</p>
        <div class="status-chip">STATUS: ${badgeText}</div>
        <div class="close-instruction">You may close this tab now.</div>
      </div>
    </body>
    </html>
  `;
};

// GET /api/system/auth-callback
router.get("/system/auth-callback", async (req, res) => {
  const parsed = HandleAuthCallbackQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.setHeader("Content-Type", "text/html");
    res.status(400).send(htmlResponse(
      "Authorization Error",
      "The authorization code was not received from Upstox. Please try again.",
      true
    ));
    return;
  }

  const type = parsed.data.state?.endsWith("_data") ? "data" : "trading";
  const cookieName = `${AUTH_STATE_COOKIE}_${type}`;
  const expectedState = req.cookies?.[cookieName] || req.cookies?.[AUTH_STATE_COOKIE];
  res.clearCookie(cookieName);
  res.clearCookie(AUTH_STATE_COOKIE);
  if (!expectedState || parsed.data.state !== expectedState) {
    req.log.error({ expectedState, receivedState: parsed.data.state }, "Auth state mismatch or missing cookie (CSRF validation failed)");
    res.setHeader("Content-Type", "text/html");
    res.status(400).send(htmlResponse(
      "Authorization Error",
      "Invalid or missing state parameter. This could be a CSRF attempt or your session expired. Please restart the login process.",
      true
    ));
    return;
  }

  try {
    await exchangeCodeForToken(parsed.data.code, type);
    
    if (type === "data") {
      // Re-connect market data stream if data token updated
      upstoxConnectionManager.resetCircuitBreakerAndConnect();
    }
    
    // Notify all connected WebSocket clients that auth succeeded
    broadcast({
      event: "system_alert",
      data: {
        message: `Upstox ${type} authorization successful.`,
      },
    });

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000/";
    res.redirect(frontendUrl + "mimir");
  } catch (err) {
    req.log.error({ err }, "Upstox auth callback failed");
    res.setHeader("Content-Type", "text/html");
    res.status(500).send(htmlResponse(
      "Authorization Failed",
      "An error occurred while exchanging the authorization code for a token. Please check backend logs.",
      true
    ));
  }
});

// --- Debug Endpoints ---
if (process.env.NODE_ENV !== "production") {
  router.use("/system/debug", (req, res, next) => {
    // Basic guard to prevent accidental access if exposed
    if (req.headers.authorization !== `Bearer ${process.env.UPSTOXBOT_ADMIN_TOKEN}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  router.get("/system/debug/ws-count", (_req, res) => {
    res.json({ count: getConnectedClients() });
  });

  const DebugRegimeSchema = z.object({ regime: z.string().optional() });

  router.post("/system/debug/set-regime", (req, res) => {
    const parsed = DebugRegimeSchema.safeParse(req.body);
    const regime = parsed.success ? parsed.data.regime : undefined;
    // For testing dynamic island regime changes, we can broadcast a mock system_alert
    // or we can just trigger an orchestrator update.
    // The instructions say: POST /api/system/debug/set-regime -> DynamicIsland expands showing old regime -> new regime
    // Dynamic island reacts to regime changes in `StatusBar` or `useStore`?
    // Let's emit a system_health with the new regime.
    broadcast({
      event: "system_alert",
      data: {
        message: `Regime changed to ${regime || "RANGING"}. Health checks: postgres=ok, redis=ok, upstox=ok, ai=ok`,
        severity: "info"
      }
    }, "system");
    res.json({ success: true, regime });
  });

  const DebugEventSchema = z.object({ event: z.string().optional() });

  router.post("/system/debug/trigger-event", (req, res) => {
    const parsed = DebugEventSchema.safeParse(req.body);
    const event = parsed.success ? parsed.data.event : undefined;
    if (event === "market:open") {
      broadcast({
        event: "system_alert",
        data: {
          message: "Market is now open. Session: MORNING (09:15 - 10:30). FII Bias: outflow. DII Bias: inflow.",
          severity: "info"
        }
      }, "system");
    }
    res.json({ success: true });
  });

  router.post("/system/debug/trigger-scan", async (req, res) => {
    // Triggers a manual scan
    try {
      await runPostMarketFullScan();
      res.json({ success: true });
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ error: "Scan failed" });
    }
  });
}

export default router;
