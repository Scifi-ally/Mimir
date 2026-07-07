/**
 * Real-Time Intraday Monitoring Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Continuously monitors watchlist stocks tick-by-tick during market hours.
 * Detects entry signals, tracks stops/targets, and generates real-time suggestions.
 *
 * Features:
 * - Tick-by-tick price monitoring
 * - Real-time setup confirmation
 * - Dynamic entry/stop/target calculation
 * - Live signal generation as prices move
 * - Technical pattern detection intraday
 */

import { logger } from "../lib/logger";
import { stateStore } from "../lib/redis_state";
import { db } from "../../db/src";
import { suggestionsTable, overnightWatchlistTable } from "../../db/src";
import { desc, eq } from "drizzle-orm";
import { getLatestPrice, getTickData } from "../market_data/tick_feeder";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { intelligenceBus } from "../intelligence/event_bus";
import { assessRisk } from "./risk_engine";
import { buildSnapshot } from "./technical";
import type { SetupCandidate, TechnicalSnapshot } from "./technical";
import {
  getISTDateStr,
  getLastCompletedTradingDayStr,
  getNextTradingDayStr,
} from "../lib/ist-time";
import { getEffectiveUniverse, STOCK_SECTOR_MAP, findStockBySymbol, fetchNiftyDailyCandles, scanStock } from "./stock_scanner";
import { detectAlerts } from "./alerts";

export const MONITORING_MAX_STOCKS = Math.max(
  5,
  Number(process.env["MONITORING_MAX_STOCKS"] ?? "30"),
);
const MONITORING_CYCLE_CONCURRENCY = Math.max(
  2,
  Number(process.env["MONITORING_CYCLE_CONCURRENCY"] ?? "8"),
);

interface WatchlistSeed {
  symbol: string;
  name: string | null;
  category: string;
  condition: string | null;
}

interface MonitoredStock {
  symbol: string;
  watchlistEntry: WatchlistSeed;
  direction: "BUY" | "SELL";
  entryPrice: number | null;
  stopPrice: number | null;
  target1: number | null;
  target2: number | null;
  highOfDay: number;
  lowOfDay: number;
  signalGenerated: boolean;
  lastCheckAt: Date;
}

interface IntraDaySignal {
  symbol: string;
  detected: boolean;
  reason: string;
  price: number;
  shouldGenerateSuggestion: boolean;
}

const monitoredStocks = new Map<string, MonitoredStock>();
let monitoringActive = false;
let lastMonitoringCycle: Date | null = null;
let lastBroadcastAt = 0;
const BROADCAST_THROTTLE_MS = 2000;

export let currentMarketRegime: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]!);
      }
    }),
  );
  return results;
}

async function getBestMonitoringSeeds(limit = MONITORING_MAX_STOCKS): Promise<{
  seeds: WatchlistSeed[];
  selectedDate: string | null;
 }> {
  const today = getISTDateStr();
  const nextTradingDay = getNextTradingDayStr();
  const lastCompletedDay = getLastCompletedTradingDayStr();
  const datesToTry = [today, nextTradingDay, lastCompletedDay];

  for (const date of datesToTry) {
    const rows = await db
      .select({
        symbol: overnightWatchlistTable.symbol,
        name: overnightWatchlistTable.name,
        category: overnightWatchlistTable.category,
        condition: overnightWatchlistTable.condition,
      })
      .from(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, date))
      .orderBy(desc(overnightWatchlistTable.priority))
      .limit(limit);
    if (rows.length > 0) {
      return { seeds: rows, selectedDate: date };
    }
  }

  const [latest] = await db
    .select({ forDate: overnightWatchlistTable.forDate })
    .from(overnightWatchlistTable)
    .orderBy(desc(overnightWatchlistTable.forDate))
    .limit(1);
  if (latest?.forDate) {
    const rows = await db
      .select({
        symbol: overnightWatchlistTable.symbol,
        name: overnightWatchlistTable.name,
        category: overnightWatchlistTable.category,
        condition: overnightWatchlistTable.condition,
      })
      .from(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, latest.forDate))
      .orderBy(desc(overnightWatchlistTable.priority))
      .limit(limit);
    if (rows.length > 0) {
      return { seeds: rows, selectedDate: latest.forDate };
    }
  }

  const fallbackUniverse = await getEffectiveUniverse(limit);
  return {
    seeds: fallbackUniverse.map((stock) => ({
      symbol: stock.symbol,
      name: stock.name,
      category: "INTRADAY_FALLBACK",
      condition:
        "Fallback monitoring set selected due to missing watchlist candidates for current date window.",
    })),
    selectedDate: null,
  };
}

function inferDirection(category: string): "BUY" | "SELL" {
  const normalized = category.toUpperCase();
  if (
    normalized.includes("SELL") ||
    normalized.includes("BREAKDOWN") ||
    normalized.includes("BEAR")
  ) {
    return "SELL";
  }
  return "BUY";
}

/**
 * Initialize monitoring for today's watchlist
 */
export async function initIntradayMonitoring(): Promise<void> {
  try {
    // Attempt recovery from Redis (e.g. after midday crash/restart)
    const recovered = await stateStore.loadAllMonitoredStocks();
    if (recovered.size > 0) {
      logger.info({ count: recovered.size }, "Restored active monitoring stocks from Redis");
      monitoredStocks.clear();
      for (const [sym, stock] of recovered.entries()) {
        monitoredStocks.set(sym, {
          ...stock,
          lastCheckAt: new Date(stock.lastCheckAt)
        });
      }
      // Re-initialize regime on recovery
      await evaluateMarketRegime();
      return;
    }

    const { seeds, selectedDate } = await getBestMonitoringSeeds(
      MONITORING_MAX_STOCKS,
    );

    if (!seeds.length) {
      logger.warn("No candidates available for intraday monitoring");
      return;
    }

    logger.info(
      {
        stocks: seeds.length,
        selectedDate: selectedDate ?? "fallback_universe",
        symbols: seeds.map((w) => w.symbol),
      },
      "Initializing intraday monitoring candidate set",
    );

    monitoredStocks.clear();

    for (const entry of seeds) {
      const latestPrice = getLatestPrice(entry.symbol);
      const direction = inferDirection(entry.category);
      const item = {
        symbol: entry.symbol,
        watchlistEntry: entry,
        direction,
        entryPrice: latestPrice,
        stopPrice: null,
        target1: null,
        target2: null,
        highOfDay: latestPrice ?? 0,
        lowOfDay: latestPrice ?? 0,
        signalGenerated: false,
        lastCheckAt: new Date(),
      };

      monitoredStocks.set(entry.symbol, item);
      await stateStore.saveMonitoredStock(entry.symbol, item);
    }

    await evaluateMarketRegime();

    broadcast(
      createServerEvent.systemAlert({
        message: `Intraday monitoring initialized: Watching ${seeds.length} stocks${selectedDate ? ` from ${selectedDate}` : " (fallback set)"}`,
        severity: "info",
      }),
    );
  } catch (err) {
    logger.error({ err }, "Failed to initialize intraday monitoring");
  }
}

async function evaluateMarketRegime() {
  try {
    const niftyCandles = await fetchNiftyDailyCandles(70);
    const snap = buildSnapshot(niftyCandles);
    if (snap) {
      if (snap.trend === "DOWN") currentMarketRegime = "BEARISH";
      else if (snap.trend === "UP") currentMarketRegime = "BULLISH";
      else currentMarketRegime = "NEUTRAL";
      logger.info({ regime: currentMarketRegime }, "Market regime evaluated");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to evaluate market regime");
  }
}

/**
 * Run continuous monitoring cycle
 * Called every 100-500ms while market is open
 */
export async function runMonitoringCycle(): Promise<void> {
  if (!monitoringActive) {
    return;
  }

  if (monitoredStocks.size === 0) {
    return;
  }

  lastMonitoringCycle = new Date();

  const stocks = Array.from(monitoredStocks.entries());
  const checks = await runWithConcurrency(
    stocks,
    MONITORING_CYCLE_CONCURRENCY,
    async ([symbol, monitored]) =>
      checkStockForIntraDaySignal(symbol, monitored),
  );
  const signals = checks.filter((signal) => signal.detected);

  // Generate suggestions for detected signals
  await runWithConcurrency(
    signals.filter((signal) => signal.shouldGenerateSuggestion),
    Math.min(3, MONITORING_CYCLE_CONCURRENCY),
    async (signal) => generateIntraDaySuggestion(signal.symbol, signal.price),
  );

  // Broadcast live monitoring status throttled to 2 seconds
  const now = Date.now();
  if (now - lastBroadcastAt >= BROADCAST_THROTTLE_MS) {
    lastBroadcastAt = now;
    broadcast(createServerEvent.monitoringUpdate(getMonitoringStatus()), "monitoring");
  }
}

/**
 * Check a single stock for intraday trading signal
 */
async function checkStockForIntraDaySignal(
  symbol: string,
  monitored: MonitoredStock,
): Promise<IntraDaySignal> {
  const latestPrice = getLatestPrice(symbol);

  if (!latestPrice) {
    return {
      symbol,
      detected: false,
      reason: "No price data",
      price: 0,
      shouldGenerateSuggestion: false,
    };
  }

  let updated = false;

  // Update daily high/low
  if (latestPrice > monitored.highOfDay) {
    monitored.highOfDay = latestPrice;
    updated = true;
  }
  if (latestPrice < monitored.lowOfDay || monitored.lowOfDay === 0) {
    monitored.lowOfDay = latestPrice;
    updated = true;
  }

  // Get tick data
  const ticks = getTickData(symbol);
  if (ticks.length < 2) {
    if (updated) {
      void stateStore.saveMonitoredStock(symbol, monitored).catch(() => {});
    }
    return {
      symbol,
      detected: false,
      reason: "Insufficient tick data",
      price: latestPrice,
      shouldGenerateSuggestion: false,
    };
  }

  // Reject BUY signals if the market regime is BEARISH
  if (currentMarketRegime === "BEARISH" && monitored.direction === "BUY") {
    return {
      symbol,
      detected: false,
      reason: "Market regime is bearish (BUY blocked)",
      price: latestPrice,
      shouldGenerateSuggestion: false,
    };
  }

  // Reject SELL signals if the market regime is BULLISH
  if (currentMarketRegime === "BULLISH" && monitored.direction === "SELL") {
    return {
      symbol,
      detected: false,
      reason: "Market regime is bullish (SELL blocked)",
      price: latestPrice,
      shouldGenerateSuggestion: false,
    };
  }

  // Analyze price action
  const recentTicks = ticks.slice(-10);
  const direction = monitored.direction;

  // Check for breakout confirmation
  const isBreakout = detectBreakoutConfirmation(recentTicks, direction);

  // Check for pullback completion
  const isPullbackComplete = detectPullbackComplete(recentTicks, direction);

  // Check for momentum continuation
  const isMomentum = detectMomentumContinuation(recentTicks, direction);

  const signalDetected = isBreakout || isPullbackComplete || isMomentum;

  if (!signalDetected) {
    if (updated) {
      void stateStore.saveMonitoredStock(symbol, monitored).catch(() => {});
    }
    return {
      symbol,
      detected: false,
      reason: "No entry signal",
      price: latestPrice,
      shouldGenerateSuggestion: false,
    };
  }

  // Only generate one suggestion per stock per day
  if (monitored.signalGenerated) {
    if (updated) {
      void stateStore.saveMonitoredStock(symbol, monitored).catch(() => {});
    }
    return {
      symbol,
      detected: true,
      reason: "Signal already generated",
      price: latestPrice,
      shouldGenerateSuggestion: false,
    };
  }

  let reason = "";
  if (isBreakout) reason = "Breakout confirmed";
  else if (isPullbackComplete) reason = "Pullback completed";
  else if (isMomentum) reason = "Momentum continuation";

  return {
    symbol,
    detected: true,
    reason,
    price: latestPrice,
    shouldGenerateSuggestion: true,
  };
}

/**
 * Detect breakout confirmation
 */
/**
 * Detect breakout confirmation
 */
export function detectBreakoutConfirmation(
  ticks: Array<{ price: number; volume: number }>,
  direction: string,
): boolean {
  if (ticks.length < 5) return false;

  const prices = ticks.map((t) => t.price);
  const highPrice = Math.max(...prices.slice(-5));
  const lowPrice = Math.min(...prices.slice(-5));
  const range = highPrice - lowPrice;
  const midPoint = lowPrice + range / 2;

  const currentPrice = prices[prices.length - 1]!;

  if (direction === "BUY") {
    // For buy: price closes above midpoint with volume
    const volumeSum = ticks.slice(-5).reduce((sum, t) => sum + t.volume, 0);
    return currentPrice > midPoint && volumeSum > 0;
  } else {
    // For sell: price closes below midpoint with volume
    const volumeSum = ticks.slice(-5).reduce((sum, t) => sum + t.volume, 0);
    return currentPrice < midPoint && volumeSum > 0;
  }
}

/**
 * Detect pullback completion
 */
export function detectPullbackComplete(
  ticks: Array<{ price: number; volume: number }>,
  direction: string,
): boolean {
  if (ticks.length < 8) return false;

  const prices = ticks.map((t) => t.price);
  const initialTrend = prices.slice(0, 3).reduce((a, b) => a + b) / 3;
  const pullback = prices.slice(3, 6).reduce((a, b) => a + b) / 3;
  const recovery = prices.slice(6).reduce((a, b) => a + b) / prices.slice(6).length;

  if (direction === "BUY") {
    // Initial up-trend, followed by a dip, followed by a recovery upward
    return initialTrend > pullback && pullback < recovery;
  } else {
    // Initial down-trend, followed by a bounce, followed by a recovery downward
    return initialTrend < pullback && pullback > recovery;
  }
}

/**
 * Detect momentum continuation
 */
export function detectMomentumContinuation(
  ticks: Array<{ price: number; volume: number }>,
  direction: string,
): boolean {
  if (ticks.length < 4) return false;

  const prices = ticks.map((t) => t.price);
  const trend1 = prices[prices.length - 1]! - prices[prices.length - 2]!;
  const trend2 = prices[prices.length - 2]! - prices[prices.length - 3]!;
  const trend3 = prices[prices.length - 3]! - prices[prices.length - 4]!;

  if (direction === "BUY") {
    return trend1 > 0 && trend2 > 0 && trend3 > 0;
  } else {
    return trend1 < 0 && trend2 < 0 && trend3 < 0;
  }
}

async function resolveTechnicalSnapshot(
  symbol: string,
  currentPrice: number,
  monitored: MonitoredStock,
): Promise<{ snap: TechnicalSnapshot; source: "live_scan" | "tick_derived" }> {
  try {
    const stock = await findStockBySymbol(symbol);
    if (stock) {
      const niftyCandles = await fetchNiftyDailyCandles(70);
      const scanResult = await scanStock(stock, niftyCandles);
      if (scanResult?.snapshot) {
        const snap = { ...scanResult.snapshot, close: currentPrice };
        
        // Detect alerts in background
        detectAlerts(symbol, {
          rsi: snap.rsi14,
          vwap: snap.vwap,
          close: snap.close,
          mtfScore: scanResult.mtfScore,
          mtfDesc: scanResult.mtfConfluenceString
        }).catch(err => logger.error({ err }, "Alert detection failed"));

        return {
          snap,
          source: "live_scan",
        };
      }
    }
  } catch (err) {
    logger.debug({ err, symbol }, "Live scan snapshot unavailable; using tick-derived indicators");
  }
  return {
    snap: buildTickDerivedSnapshot(symbol, currentPrice, monitored),
    source: "tick_derived",
  };
}

/**
 * Build a technical snapshot from live tick data when scan snapshot is unavailable.
 */
function buildTickDerivedSnapshot(
  symbol: string,
  currentPrice: number,
  monitored: MonitoredStock,
): TechnicalSnapshot {
  const ticks = getTickData(symbol);
  const prices = ticks.map((t) => t.price);
  const ema9 = prices.length ? calcSimpleEma(prices, 9) : currentPrice;
  const ema20 = prices.length ? calcSimpleEma(prices, 20) : currentPrice;
  const volumes = ticks.map((t) => t.volume);
  const avgVolume =
    volumes.length > 0
      ? volumes.reduce((sum, value) => sum + value, 0) / volumes.length
      : 0;
  const recentVolume =
    volumes.slice(-5).reduce((sum, value) => sum + value, 0) /
    Math.max(1, Math.min(5, volumes.length));
  const volumeRatio = avgVolume > 0 ? recentVolume / avgVolume : 1;
  const sessionRangePct =
    currentPrice > 0
      ? ((monitored.highOfDay - monitored.lowOfDay) / currentPrice) * 100
      : 1.5;
  const atr14 = currentPrice * (Math.max(0.8, sessionRangePct) / 100);

  return {
    close: currentPrice,
    avgDailyVolume: Math.max(avgVolume, recentVolume, 1),
    atr14,
    rsi14: estimateRsiFromPrices(prices),
    ema9,
    ema20,
    ema50: ema20,
    ema200: ema20,
    volumeRatio,
    adx14: estimateAdxFromPrices(prices),
    high52w: Math.max(monitored.highOfDay, currentPrice),
    low52w: Math.min(monitored.lowOfDay || currentPrice, currentPrice),
    distFromEma20Pct:
      ema20 > 0 ? ((currentPrice - ema20) / ema20) * 100 : 0,
    trend: currentPrice >= ema20 ? "UP" : "DOWN",
    swingLow: monitored.lowOfDay || currentPrice * 0.98,
    swingHigh: monitored.highOfDay || currentPrice * 1.02,
    vwap: currentPrice, // Fallback for tick-derived
    superTrend: currentPrice, // Fallback for tick-derived
    vpvrPOC: currentPrice, // Fallback for tick-derived
    volumeAnomaly: volumeRatio >= 3.0,
  };
}

function calcSimpleEma(values: number[], period: number): number {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let ema = values[0]!;
  for (let i = 1; i < values.length; i += 1) {
    ema = values[i]! * k + ema * (1 - k);
  }
  return ema;
}

function estimateRsiFromPrices(prices: number[]): number {
  if (prices.length < 3) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < prices.length; i += 1) {
    const delta = prices[i]! - prices[i - 1]!;
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  if (losses === 0) return gains > 0 ? 70 : 50;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function estimateAdxFromPrices(prices: number[]): number {
  if (prices.length < 4) return 0;
  let directional = 0;
  for (let i = 1; i < prices.length; i += 1) {
    directional += Math.abs(prices[i]! - prices[i - 1]!);
  }
  const avgMove = directional / (prices.length - 1);
  const range = Math.max(...prices) - Math.min(...prices);
  if (range <= 0) return 0;
  return Math.min(100, (avgMove / range) * 100);
}

let activeSuggestionsCache: { symbols: Set<string>; timestamp: number } = {
  symbols: new Set(),
  timestamp: 0,
};

async function getActiveSymbolsSet(): Promise<Set<string>> {
  const now = Date.now();
  if (now - activeSuggestionsCache.timestamp < 30000 && activeSuggestionsCache.symbols.size > 0) {
    return activeSuggestionsCache.symbols;
  }
  try {
    const rows = await db
      .select({ symbol: suggestionsTable.symbol })
      .from(suggestionsTable)
      .where(eq(suggestionsTable.status, "ACTIVE"));
    const symbols = new Set(rows.map((r) => r.symbol));
    activeSuggestionsCache = { symbols, timestamp: now };
    return symbols;
  } catch {
    return activeSuggestionsCache.symbols;
  }
}

/**
 * Generate intraday suggestion when signal is confirmed
 */
async function generateIntraDaySuggestion(
  symbol: string,
  currentPrice: number,
): Promise<void> {
  const monitored = monitoredStocks.get(symbol);
  if (!monitored || monitored.signalGenerated || currentPrice <= 0) return;

  try {
    const activeSymbols = await getActiveSymbolsSet();
    if (activeSymbols.has(symbol)) {
      monitored.signalGenerated = true;
      await stateStore.saveMonitoredStock(symbol, monitored).catch(() => {});
      return;
    }

    const direction = monitored.direction;

    const stopLoss =
      direction === "BUY"
        ? currentPrice * 0.99
        : currentPrice * 1.01;
    const target1 =
      direction === "BUY"
        ? currentPrice * 1.015
        : currentPrice * 0.985;
    const target2 =
      direction === "BUY"
        ? currentPrice * 1.03
        : currentPrice * 0.97;

    const setup: SetupCandidate = {
      setupType: "INTRADAY_SIGNAL",
      direction,
      score: 70,
      entryPrice: currentPrice,
      stopLoss,
      target1,
      target2,
      riskReward: 1.5,
      reasoning: `Intraday signal: ${monitored.watchlistEntry.condition}`,
      confluence: [monitored.watchlistEntry.category],
    };

    const { snap, source: indicatorSource } = await resolveTechnicalSnapshot(
      symbol,
      currentPrice,
      monitored,
    );

    const sector = STOCK_SECTOR_MAP[symbol] ?? "Other";
    const riskAssessment = await assessRisk(setup, snap, sector);

    if (!riskAssessment.passed) {
      logger.warn({ symbol, reasons: riskAssessment.rejectionReasons }, "Intraday signal rejected by Risk Engine");
      return;
    }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [inserted] = await db
      .insert(suggestionsTable)
      .values({
      symbol,
      name: monitored.watchlistEntry.name,
      exchange: "NSE",
      direction,
      tradeType: "INTRADAY",
      setupType: "INTRADAY_SIGNAL",
      entryPrice: currentPrice.toString(),
      stopLoss: stopLoss.toString(),
      target1: target1.toString(),
      target2: target2.toString(),
      riskReward: riskAssessment.riskReward.toString(),
      quantity: riskAssessment.positionSize,
      maxRiskInr: riskAssessment.maxRiskInr.toString(),
      stopDistancePct: riskAssessment.stopDistancePct.toString(),
      marketRegime: "INTRADAY",
      reasoning: `Intraday signal: ${monitored.watchlistEntry.condition}`,
      validityTill: tomorrow.toISOString().slice(0, 10),
      status: "ACTIVE",
      atr: snap.atr14.toString(),
      highestPrice: currentPrice.toString(),
      lowestPrice: currentPrice.toString(),
      signalFactors: {
        source: indicatorSource,
        tickCount: getTickData(symbol).length,
        volumeRatio: Number(snap.volumeRatio.toFixed(2)),
        rsi14: Number(snap.rsi14.toFixed(1)),
        adx14: Number(snap.adx14.toFixed(1)),
        sessionRangePct: Number(
          (
            currentPrice > 0
              ? ((monitored.highOfDay - monitored.lowOfDay) / currentPrice) * 100
              : 0
          ).toFixed(2),
        ),
        category: monitored.watchlistEntry.category,
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
      .returning();

    if (!inserted) {
      logger.warn({ symbol }, "Intraday suggestion insert returned no row");
      return;
    }

    activeSuggestionsCache.symbols.add(symbol);
    monitored.signalGenerated = true;
    await stateStore.saveMonitoredStock(symbol, monitored).catch(() => {});

    broadcast(
      createServerEvent.newSuggestion({
        id: inserted.id,
        symbol,
        direction,
        entryPrice: currentPrice,
        stopLoss,
        target1,
        setupType: "INTRADAY_SIGNAL",
        riskReward: riskAssessment.riskReward,
      }),
      "suggestions",
    );

    intelligenceBus.publish("suggestionGenerated", {
      suggestion: {
        id: inserted.id,
        instrumentKey: `NSE_EQ|${symbol}`,
        symbol,
        direction,
        setup: "INTRADAY_SIGNAL",
        confidence: 80,
        entry: currentPrice,
        stopLoss,
        target: target1,
        target1,
        riskReward: riskAssessment.riskReward,
        reasoning: [`Intraday signal: ${monitored.watchlistEntry.condition}`],
        generatedAt: Date.now(),
        expiresAt: Date.now() + 20 * 60_000,
      } as any
    });

    logger.info(
      {
        symbol,
        direction,
        entry: currentPrice,
        stop: stopLoss,
        target1,
      },
      "Intraday suggestion generated",
    );
  } catch (err) {
    logger.error({ err, symbol }, "Failed to generate intraday suggestion");
  }
}

/**
 * Get monitoring status
 */
export function getMonitoringStatus() {
  const monitoredStocksList = Array.from(monitoredStocks.values()).map((m) => ({
    symbol: m.symbol,
    entryPrice: m.entryPrice,
    currentPrice: getLatestPrice(m.symbol),
    highOfDay: m.highOfDay,
    lowOfDay: m.lowOfDay,
    signalGenerated: m.signalGenerated,
    lastCheckAt: m.lastCheckAt.toISOString(),
  }));

  return {
    active: monitoringActive,
    monitoredStocks: monitoredStocksList,
    monitoredStocksCount: monitoredStocksList.length,
    lastMonitoringCycle: lastMonitoringCycle?.toISOString() ?? null,
    monitoringMaxStocks: MONITORING_MAX_STOCKS,
    maxLimit: MONITORING_MAX_STOCKS,
  };
}

/**
 * Start continuous monitoring
 */
export function startMonitoring(): void {
  monitoringActive = true;
  logger.info("Intraday monitoring started");
}

/**
 * Stop continuous monitoring
 */
export function stopMonitoring(): void {
  monitoringActive = false;
  monitoredStocks.clear();
  void stateStore.clearMonitoredStocks().catch(() => {});
  logger.info("Intraday monitoring stopped");
}
