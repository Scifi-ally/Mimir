import { db } from "../../db/src";
import { institutionalFlowsTable } from "../../db/src/schema/institutional_flows";
import { desc } from "drizzle-orm";
import { yahooFinance } from "../lib/yahoo-client";
import { logger } from "../lib/logger";

export interface DivergenceResult {
  fiiNet5d: number | null;
  diiNet5d: number | null;
  totalFlow5d: number | null;
  niftyReturn5d: number | null;
  isDiverging: boolean | null;
  divergenceType: "BULLISH" | "BEARISH" | "NONE" | "UNKNOWN";
  penaltyOrBoost: number | null;
  available: boolean;
}

export async function computeFiiDiiDivergence(): Promise<DivergenceResult> {
  const defaultRes: DivergenceResult = {
    fiiNet5d: null, diiNet5d: null, totalFlow5d: null, niftyReturn5d: null,
    isDiverging: null, divergenceType: "UNKNOWN", penaltyOrBoost: null, available: false
  };

  try {
    const flows = await db.select()
      .from(institutionalFlowsTable)
      .orderBy(desc(institutionalFlowsTable.date))
      .limit(5);

    if (flows.length < 5 || flows.some(f => !Number.isFinite(f.fiiNet) || !Number.isFinite(f.diiNet)
      || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) || new Set(flows.map(f => f.date)).size !== 5) return defaultRes;
    const flowDates = flows.map(f => f.date).sort();
    const latestFlow = Date.parse(flowDates[4] + "T15:30:00+05:30");
    if (!Number.isFinite(latestFlow) || latestFlow > Date.now() || Date.now() - latestFlow > 7 * 86400000) return defaultRes;

    let fiiNet5d = 0;
    let diiNet5d = 0;
    for (const f of flows) {
      fiiNet5d += f.fiiNet;
      diiNet5d += f.diiNet;
    }
    const totalFlow5d = fiiNet5d + diiNet5d;
    Object.assign(defaultRes, { fiiNet5d, diiNet5d, totalFlow5d });

    const queryOptions = { period1: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], interval: "1d" as const };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await yahooFinance.historical("^NSEI", queryOptions)) as any[];
    
    const completed = result.filter(row => row.date instanceof Date && Number.isFinite(row.date.getTime())
      && Number.isFinite(row.close) && row.close > 0)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const recent = completed.filter(row => row.date.toISOString().slice(0, 10) <= flowDates[4]).slice(-6);
    if (recent.length !== 6 || recent.slice(1).some((row, i) => row.date.toISOString().slice(0, 10) !== flowDates[i])) return defaultRes;
    const oldestClose = recent[0].close;
    const newestClose = recent[recent.length - 1].close;
    
    const niftyReturn5d = ((newestClose - oldestClose) / oldestClose) * 100;

    let divergenceType: "BULLISH" | "BEARISH" | "NONE" = "NONE";
    let penaltyOrBoost = 0;

    if (niftyReturn5d < -1.0 && totalFlow5d > 2000) {
      divergenceType = "BULLISH";
      penaltyOrBoost = 10;
    } 
    else if (niftyReturn5d > 1.0 && totalFlow5d < -2000) {
      divergenceType = "BEARISH";
      penaltyOrBoost = -10;
    }

    return {
      fiiNet5d,
      diiNet5d,
      totalFlow5d,
      niftyReturn5d,
      isDiverging: divergenceType !== "NONE",
      divergenceType,
      penaltyOrBoost,
      available: true
    };
  } catch (err) {
    logger.error({ err }, "Failed to compute FII/DII divergence");
    return defaultRes;
  }
}

let cachedDivergence: DivergenceResult | null = null;
let cachedDivergenceAt = 0;

export async function getFiiDiiDivergence(): Promise<DivergenceResult> {
  const age = Date.now() - cachedDivergenceAt;
  if (cachedDivergence && age >= 0 && age < 15 * 60 * 1000) return cachedDivergence;
  cachedDivergence = await computeFiiDiiDivergence();
  cachedDivergenceAt = Date.now();
  return cachedDivergence;
}

export function resetDivergenceCache() {
  cachedDivergence = null;
}

export interface CvdDivergenceResult {
  symbol: string;
  divergenceType: "BULLISH_ABSORPTION" | "BEARISH_EXHAUSTION" | "HIDDEN_BULLISH" | "HIDDEN_BEARISH" | "NEUTRAL";
  signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  isDiverging: boolean;
  confidence: number;
  penaltyOrBoost: number;
  currentCvd: number;
  netDelta?: number;
  priorCvd: number;
  cvdSlope: "RISING" | "FALLING" | "FLAT";
  priceSlope: "RISING" | "FALLING" | "FLAT";
  priceReturnPct: number;
  barsEvaluated: number;
  timeframe: string;
  description: string;
  available: boolean;
}

export interface CandleInput {
  date?: string | Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Computes Cumulative Volume Delta (CVD) and detects institutional order flow divergences
 * across a series of OHLCV candles.
 */
export function computeCvdFromCandles(
  candles: CandleInput[],
  symbol = "NIFTY 50",
  timeframe = "15m"
): CvdDivergenceResult {
  const defaultRes: CvdDivergenceResult = {
    symbol,
    divergenceType: "NEUTRAL",
    signal: "NEUTRAL",
    isDiverging: false,
    confidence: 0,
    penaltyOrBoost: 0,
    currentCvd: 0,
    priorCvd: 0,
    cvdSlope: "FLAT",
    priceSlope: "FLAT",
    priceReturnPct: 0,
    barsEvaluated: 0,
    timeframe,
    description: "Insufficient candle data for CVD divergence analysis",
    available: false,
  };

  const validCandles = candles.filter(
    (c) =>
      Number.isFinite(c.close) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.volume) &&
      c.high >= c.low &&
      c.close > 0
  );

  if (validCandles.length < 5) return defaultRes;

  // 1. Calculate intra-candle delta and cumulative volume delta
  let runningCvd = 0;
  const cvdSeries: Array<{
    close: number;
    high: number;
    low: number;
    volume: number;
    delta: number;
    cvd: number;
  }> = [];

  for (const c of validCandles) {
    const range = Math.max(0.0001, c.high - c.low);
    // Close location value (-1 to +1)
    const clv = ((c.close - c.low) - (c.high - c.close)) / range;
    // Candle body directional bias (-1 to +1)
    const body = (c.close - c.open) / range;
    const deltaRatio = Math.max(-1, Math.min(1, (clv + body) / 2));
    const delta = Math.round(c.volume * deltaRatio);
    runningCvd += delta;
    cvdSeries.push({
      close: c.close,
      high: c.high,
      low: c.low,
      volume: c.volume,
      delta,
      cvd: runningCvd,
    });
  }

  // 2. Analyze the rolling lookback window for pivots and slopes
  const lookback = Math.min(30, cvdSeries.length);
  const startIdx = cvdSeries.length - lookback;
  const p0 = cvdSeries[startIdx]!;
  const pLatest = cvdSeries[cvdSeries.length - 1]!;
  const priorCvd = p0.cvd;
  const currentCvd = pLatest.cvd;

  const priceReturnPct = Number(
    (((pLatest.close - p0.close) / p0.close) * 100).toFixed(2)
  );
  const cvdDelta = currentCvd - priorCvd;

  const priceSlope: "RISING" | "FALLING" | "FLAT" =
    priceReturnPct > 0.35 ? "RISING" : priceReturnPct < -0.35 ? "FALLING" : "FLAT";
  const cvdSlope: "RISING" | "FALLING" | "FLAT" =
    cvdDelta > 0 ? "RISING" : cvdDelta < 0 ? "FALLING" : "FLAT";

  // 3. Detect swing highs and swing lows across the lookback
  const swingLows: number[] = [];
  const swingHighs: number[] = [];
  for (let i = startIdx + 1; i < cvdSeries.length - 1; i++) {
    const prev = cvdSeries[i - 1]!;
    const cur = cvdSeries[i]!;
    const next = cvdSeries[i + 1]!;
    if (cur.low <= prev.low && cur.low <= next.low) swingLows.push(i);
    if (cur.high >= prev.high && cur.high >= next.high) swingHighs.push(i);
  }

  let divergenceType: CvdDivergenceResult["divergenceType"] = "NEUTRAL";
  let signal: CvdDivergenceResult["signal"] = "NEUTRAL";
  let confidence = 50;
  let penaltyOrBoost = 0;
  let description = "Neutral: Price action and cumulative volume delta are aligned.";

  // Check swing low divergence (Bullish absorption or Hidden bullish)
  if (swingLows.length >= 2) {
    const l1 = cvdSeries[swingLows[swingLows.length - 2]!]!;
    const l2 = cvdSeries[swingLows[swingLows.length - 1]!]!;
    const priceLowerLow = l2.low < l1.low;
    const cvdHigherLow = l2.cvd > l1.cvd;
    const priceHigherLow = l2.low > l1.low;
    const cvdLowerLow = l2.cvd < l1.cvd;

    if (priceLowerLow && cvdHigherLow) {
      divergenceType = "BULLISH_ABSORPTION";
      signal = "BULLISH";
      confidence = 85;
      penaltyOrBoost = 12;
      description =
        "Regular Bullish Divergence (Delta Absorption): Price printed lower low while CVD formed higher low, indicating aggressive institutional absorption.";
    } else if (priceHigherLow && cvdLowerLow) {
      divergenceType = "HIDDEN_BULLISH";
      signal = "BULLISH";
      confidence = 72;
      penaltyOrBoost = 8;
      description =
        "Hidden Bullish Divergence: CVD reset lower while price maintained higher low structure, signaling bullish continuation.";
    }
  }

  // Check swing high divergence (Bearish exhaustion or Hidden bearish)
  if (divergenceType === "NEUTRAL" && swingHighs.length >= 2) {
    const h1 = cvdSeries[swingHighs[swingHighs.length - 2]!]!;
    const h2 = cvdSeries[swingHighs[swingHighs.length - 1]!]!;
    const priceHigherHigh = h2.high > h1.high;
    const cvdLowerHigh = h2.cvd < h1.cvd;
    const priceLowerHigh = h2.high < h1.high;
    const cvdHigherHigh = h2.cvd > h1.cvd;

    if (priceHigherHigh && cvdLowerHigh) {
      divergenceType = "BEARISH_EXHAUSTION";
      signal = "BEARISH";
      confidence = 85;
      penaltyOrBoost = -12;
      description =
        "Regular Bearish Divergence (Delta Exhaustion): Price printed higher high while CVD formed lower high, indicating buyer exhaustion and distribution.";
    } else if (priceLowerHigh && cvdHigherHigh) {
      divergenceType = "HIDDEN_BEARISH";
      signal = "BEARISH";
      confidence = 72;
      penaltyOrBoost = -8;
      description =
        "Hidden Bearish Divergence: CVD made higher high into lower price high, indicating trapped aggressive buyers and trend continuation.";
    }
  }

  // Fallback to slope divergence if swing pivots are not far enough apart
  if (divergenceType === "NEUTRAL") {
    if (priceSlope === "FALLING" && cvdSlope === "RISING") {
      divergenceType = "BULLISH_ABSORPTION";
      signal = "BULLISH";
      confidence = 78;
      penaltyOrBoost = 10;
      description =
        "Bullish Absorption Flow: Price is drifting downward while cumulative buy delta is actively expanding.";
    } else if (priceSlope === "RISING" && cvdSlope === "FALLING") {
      divergenceType = "BEARISH_EXHAUSTION";
      signal = "BEARISH";
      confidence = 78;
      penaltyOrBoost = -10;
      description =
        "Bearish Exhaustion Flow: Price is advancing while cumulative delta is bleeding negative, warning of an imminent reversal.";
    }
  }

  return {
    symbol,
    divergenceType,
    signal,
    isDiverging: divergenceType !== "NEUTRAL",
    confidence,
    penaltyOrBoost,
    currentCvd,
    priorCvd,
    cvdSlope,
    priceSlope,
    priceReturnPct,
    barsEvaluated: cvdSeries.length,
    timeframe,
    description,
    available: true,
  };
}

/**
 * Maps a display symbol to the most liquid Yahoo Finance ticker with volume.
 */
function resolveYahooTicker(symbol: string): string {
  const norm = symbol.trim().toUpperCase();
  if (norm === "NIFTY 50" || norm === "NIFTY" || norm === "^NSEI") {
    return "NIFTYBEES.NS";
  }
  if (norm === "BANKNIFTY" || norm === "BANK NIFTY" || norm === "^NSEBANK") {
    return "BANKBEES.NS";
  }
  if (norm === "SENSEX" || norm === "^BSESN") {
    return "^BSESN";
  }
  if (norm.startsWith("^") || norm.endsWith(".NS") || norm.endsWith(".BO")) {
    return norm;
  }
  return `${norm}.NS`;
}

/**
 * Computes CVD divergence by fetching historical/intraday candles from Yahoo Finance.
 */
export async function computeCvdDivergence(
  symbol = "NIFTY 50",
  timeframe = "15m"
): Promise<CvdDivergenceResult> {
  const fallbackRes: CvdDivergenceResult = {
    symbol,
    divergenceType: "NEUTRAL",
    signal: "NEUTRAL",
    isDiverging: false,
    confidence: 0,
    penaltyOrBoost: 0,
    currentCvd: 0,
    priorCvd: 0,
    cvdSlope: "FLAT",
    priceSlope: "FLAT",
    priceReturnPct: 0,
    barsEvaluated: 0,
    timeframe,
    description: "CVD divergence computation unavailable",
    available: false,
  };

  try {
    const yfTicker = resolveYahooTicker(symbol);
    const period1 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const period2 = new Date();

    const chartRes = (await yahooFinance.chart(yfTicker, {
      period1,
      period2,
      interval: timeframe as "15m" | "5m" | "1d" | "1h",
    })) as { quotes?: CandleInput[] };

    const quotes = chartRes?.quotes ?? [];
    if (quotes.length >= 5) {
      return computeCvdFromCandles(quotes, symbol, timeframe);
    }

    // Secondary fallback: if 15m had insufficient volume (e.g. index ticker), try daily
    if (timeframe !== "1d") {
      const dailyRes = (await yahooFinance.chart(yfTicker, {
        period1: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        period2: new Date(),
        interval: "1d",
      })) as { quotes?: CandleInput[] };

      if (dailyRes?.quotes && dailyRes.quotes.length >= 5) {
        return computeCvdFromCandles(dailyRes.quotes, symbol, "1d");
      }
    }

    return fallbackRes;
  } catch (err) {
    logger.warn({ err, symbol }, "Failed to compute CVD divergence");
    return fallbackRes;
  }
}

const cvdCache = new Map<string, { at: number; data: CvdDivergenceResult }>();

/**
 * Returns cached CVD divergence (cached for 60 seconds per symbol/timeframe).
 */
export async function getCvdDivergence(
  symbol = "NIFTY 50",
  timeframe = "15m"
): Promise<CvdDivergenceResult> {
  const cacheKey = `${symbol}:${timeframe}`;
  const cached = cvdCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < 60_000) {
    return cached.data;
  }

  const result = await computeCvdDivergence(symbol, timeframe);
  if (result.available) {
    cvdCache.set(cacheKey, { at: now, data: result });
  }
  return result;
}

export function resetCvdDivergenceCache(symbol?: string) {
  if (symbol) {
    for (const key of cvdCache.keys()) {
      if (key.startsWith(symbol)) cvdCache.delete(key);
    }
  } else {
    cvdCache.clear();
  }
}
