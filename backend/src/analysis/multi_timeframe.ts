/**
 * Multi-Timeframe Analysis
 * ─────────────────────────────────────────────────────────────────────────────
 * Analyzes stocks across multiple timeframes (1h, 4h, daily, weekly) for:
 * - Trend alignment across timeframes
 * - Confluence of technical signals
 * - Higher probability entry points
 * - Better risk/reward validation
 */

import { logger } from "../lib/logger";
import { getAccessToken } from "../upstox/auth";
import { db, candlesTable } from "../../db/src";
import { and, eq, gte, lte, asc, sql } from "drizzle-orm";
import { createUpstoxClient } from "../lib/upstox-client";
import {
  buildSnapshot,
  TechnicalSnapshot,
  computeEMA,
  OHLCV,
  aggregateDailyToWeekly,
} from "./technical";
import {
  getISTDateStr,
  getISTDayBounds,
  getLastCompletedTradingDayStr,
  shiftISTDateStr,
} from "../lib/ist-time";
const upstoxClient = createUpstoxClient({ cacheTimeMs: 10 * 60 * 1000 });

// ── Timeframe intervals ──────────────────────────────────────────────────────

export type Timeframe = "1h" | "4h" | "daily" | "weekly";

export interface MultiTimeframeData {
  tf1h: OHLCV[];
  tf4h: OHLCV[];
  tfDaily: OHLCV[];
  tfWeekly: OHLCV[];
}

export interface TimeframeAnalysis {
  timeframe: Timeframe;
  snapshot: TechnicalSnapshot;
  trend: "UP" | "DOWN" | "RANGING";
  strength: number; // 0-10 score for trend strength
  emaOrder: boolean; // true if 9 < 20 < 50 on uptrend or 9 > 20 > 50 on downtrend
}

export interface MultiTimeframeSignal {
  direction: "BUY" | "SELL" | "NEUTRAL";
  dailyTrend: "UP" | "DOWN" | "RANGING";
  weeklyTrend: "UP" | "DOWN" | "RANGING";
  hourlyConfirm: boolean; // Does 1h/4h confirm daily direction?
  confluenceScore: number; // 0-100: % of timeframes aligned
  crossover1h: boolean; // Is 1h price crossing its 20 EMA?
  crossover4h: boolean; // Is 4h price crossing its 20 EMA?
  volumeIncrease: boolean; // Is volume increasing on move?
  mtf_score: number;
  mtf_total: number;
  mtf_confluence: 'STRONG ALIGN' | 'PARTIAL' | 'DIVERGING' | 'PENDING';
}

// ── Fetch helpers for multi-timeframe data ───────────────────────────────────

// Instruments whose history simply starts later than the requested range
// (new listings): once a head backfill returns nothing older than the cache
// head, remember the earliest available date per instrument|interval so we
// stop re-fetching the same empty head range on every call. Interior cache
// holes (e.g. from downtime mid-range) are not detected or repaired here —
// head/tail checks cannot see them.
const earliestKnownHistoryStart = new Map<string, string>();

export async function fetchCandles(
  instrumentKey: string,
  interval: string,
  daysBack: number,
  toDate?: string,
): Promise<OHLCV[]> {
  const token = getAccessToken();
  if (!token) {
    logger.warn("fetchCandles: No authentication token available");
    return [];
  }

  const defaultToDate =
    interval === "day" || interval === "week"
      ? getLastCompletedTradingDayStr()
      : getISTDateStr();
  const toDateStr = toDate ?? defaultToDate;
  const fromDateStr = shiftISTDateStr(toDateStr, -daysBack);

  // Candle timestamps are IST — use IST day bounds so a historical toDate
  // doesn't leak the next day's candle (lookahead) or drop fromDate's own.
  const fromDateTime = getISTDayBounds(fromDateStr).start;
  const toDateTime = getISTDayBounds(toDateStr).end;

  // The historical endpoint serves data only up to the previous trading day;
  // candles for the current session come from the separate intraday endpoint.
  const todayISTStr = getISTDateStr();
  const includesToday = interval.endsWith("minute") && toDateStr >= todayISTStr;

  // A closed market day (or pre-open) legitimately yields no intraday candles,
  // and a transient intraday failure must never take down the whole fetch —
  // degrade to historical-only data.
  const fetchTodayIntradayCandles = async (): Promise<unknown[][]> => {
    try {
      return await upstoxClient.fetchIntradayCandles(
        instrumentKey,
        interval as "60minute" | "240minute",
        token,
      );
    } catch (err) {
      logger.warn(
        { err, instrument: instrumentKey, interval },
        "Intraday candle fetch failed; continuing with historical data only",
      );
      return [];
    }
  };

  try {
    // 1. Fetch cached candles from the database
    const cachedCandles = await db
      .select()
      .from(candlesTable)
      .where(
        and(
          eq(candlesTable.instrumentKey, instrumentKey),
          eq(candlesTable.interval, interval),
          gte(candlesTable.timestamp, fromDateTime),
          lte(candlesTable.timestamp, toDateTime)
        )
      )
      .orderBy(asc(candlesTable.timestamp));

    const lastCachedTime = cachedCandles.length > 0 ? cachedCandles[cachedCandles.length - 1].timestamp : null;
    let apiCandles: unknown[][] = [];

    // 2. Fetch delta if needed
    if (cachedCandles.length === 0) {
      // Empty cache, fetch full series
      apiCandles = await upstoxClient.fetchHistoricalCandles(
        instrumentKey,
        interval as "day" | "60minute" | "240minute" | "week",
        toDateStr,
        fromDateStr,
        token,
      );
      if (includesToday) {
        apiCandles = apiCandles.concat(await fetchTodayIntradayCandles());
      }
    } else {
      const lastCachedDateStr = getISTDateStr(lastCachedTime!);
      // Intraday candles for the current day go stale as the session
      // progresses; refresh when the last cached candle is older than the
      // staleness window (must stay >= the upstox client's intraday cache
      // TTL to have any effect).
      const INTRADAY_STALENESS_MS = 15 * 60 * 1000;
      const intradayStale =
        includesToday &&
        lastCachedDateStr === todayISTStr &&
        Date.now() - lastCachedTime!.getTime() > INTRADAY_STALENESS_MS;
      if (lastCachedDateStr < toDateStr) {
        // Fetch only the missing completed-day delta from the historical API
        // (the upsert below handles overlap on the lastCachedDateStr day).
        // It never returns current-day candles, so skip it when only today's
        // data is missing for an intraday interval.
        if (!includesToday || lastCachedDateStr < todayISTStr) {
          apiCandles = await upstoxClient.fetchHistoricalCandles(
            instrumentKey,
            interval as "day" | "60minute" | "240minute" | "week",
            toDateStr,
            lastCachedDateStr,
            token,
          );
        }
      }
      if (includesToday && (lastCachedDateStr < todayISTStr || intradayStale)) {
        apiCandles = apiCandles.concat(await fetchTodayIntradayCandles());
      }

      // Head backfill: if the cache is missing the older part of the requested
      // range, fetch it. Allow a tolerance since fromDateStr is calendar days —
      // weekends/holidays legitimately push the earliest candle a few days later.
      const earliestCachedDateStr = getISTDateStr(cachedCandles[0].timestamp);
      const HEAD_GAP_TOLERANCE_DAYS = 7;
      const histKey = `${instrumentKey}|${interval}`;
      const knownHistoryStart = earliestKnownHistoryStart.get(histKey);
      const headMissing =
        earliestCachedDateStr > shiftISTDateStr(fromDateStr, HEAD_GAP_TOLERANCE_DAYS) &&
        // Skip when a previous head fetch established that the instrument's
        // history simply starts at the cache head (new listing) — otherwise
        // the empty head range would be re-fetched forever.
        (knownHistoryStart === undefined || earliestCachedDateStr > knownHistoryStart);
      if (headMissing) {
        const headCandles = await upstoxClient.fetchHistoricalCandles(
          instrumentKey,
          interval as "day" | "60minute" | "240minute" | "week",
          earliestCachedDateStr,
          fromDateStr,
          token,
        );
        const gotOlder = headCandles.some(
          (c) => getISTDateStr(new Date(c[0] as string)) < earliestCachedDateStr,
        );
        if (!gotOlder) {
          earliestKnownHistoryStart.set(histKey, earliestCachedDateStr);
        }
        apiCandles = apiCandles.concat(headCandles);
      }
    }

    // 3. Upsert new candles into the database
    if (apiCandles.length > 0) {
      const rowsToUpsert = apiCandles.map((c) => ({
        instrumentKey,
        interval,
        timestamp: new Date(c[0] as string),
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
        updatedAt: new Date(),
      }));

      // Batch upsert using onConflictDoUpdate
      await db.insert(candlesTable)
        .values(rowsToUpsert)
        .onConflictDoUpdate({
          target: [candlesTable.instrumentKey, candlesTable.interval, candlesTable.timestamp],
          set: {
            open: sql`EXCLUDED.open`,
            high: sql`EXCLUDED.high`,
            low: sql`EXCLUDED.low`,
            close: sql`EXCLUDED.close`,
            volume: sql`EXCLUDED.volume`,
            updatedAt: new Date(),
          },
        });
    }

    // 4. Return complete set from database
    const allCandles = await db
      .select()
      .from(candlesTable)
      .where(
        and(
          eq(candlesTable.instrumentKey, instrumentKey),
          eq(candlesTable.interval, interval),
          gte(candlesTable.timestamp, fromDateTime),
          lte(candlesTable.timestamp, toDateTime)
        )
      )
      .orderBy(asc(candlesTable.timestamp));

    return allCandles.map((r) => ({
      timestamp: r.timestamp.toISOString(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  } catch (err) {
    logger.error(
      {
        err,
        instrument: instrumentKey,
        interval,
        daysBack,
        period: `${fromDateStr} to ${toDateStr}`,
        errorMessage: String(err),
      },
      "fetchCandles fallback: direct Upstox call due to DB error",
    );
    const candles = await upstoxClient.fetchHistoricalCandles(
      instrumentKey,
      interval as "day" | "60minute" | "240minute" | "week",
      toDateStr,
      fromDateStr,
      token,
    );
    const intradayCandles = includesToday ? await fetchTodayIntradayCandles() : [];
    // Both series arrive newest-first and today's intraday candles are newer
    // than anything the historical endpoint serves. Copy before reversing —
    // the client caches and returns these arrays by reference, so an in-place
    // .reverse() would corrupt the cached series for subsequent callers.
    return [...intradayCandles, ...candles]
      .reverse()
      .map((c) => ({
        timestamp: c[0] as string,
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
      }));
  }
}

/**
 * Fetch all timeframes in parallel for a stock
 * - 1h: last 20 calendar days = ~95 candles
 * - 4h: last 60 calendar days = ~80 candles
 * - Daily: last 420 calendar days = ~290 candles
 * - Weekly: aggregated from the daily series = ~60 candles
 */
export async function fetchMultiTimeframeData(
  instrumentKey: string,
  toDate?: string,
): Promise<MultiTimeframeData> {
  const [tf1h, tf4h, tfDaily] = await Promise.all([
    fetchCandles(instrumentKey, "60minute", 20, toDate),
    fetchCandles(instrumentKey, "240minute", 60, toDate),
    // 420 days ≈ 60 weeks of dailies: aggregation must yield enough weekly
    // bars to clear buildSnapshot's 55-candle minimum and analyzeTimeframe's
    // 50-bar gate (180 days gave ~26 weekly bars — weekly analysis was
    // permanently null).
    fetchCandles(instrumentKey, "day", 420, toDate),
  ]);
  
  const tfWeekly = aggregateDailyToWeekly(tfDaily);

  return { tf1h, tf4h, tfDaily, tfWeekly };
}



// ── Analyze single timeframe ─────────────────────────────────────────────────

function analyzeTimeframe(
  candles: OHLCV[],
  timeframe: Timeframe,
): TimeframeAnalysis | null {
  if (candles.length < 50) return null;

  const snapshot = buildSnapshot(candles);
  if (!snapshot) return null;

  const closes = candles.map((c) => c.close);
  const ema9 = computeEMA(closes, 9);
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);

  const lastClose = closes[closes.length - 1]!;
  const lastEma9 = ema9[ema9.length - 1]!;
  const lastEma20 = ema20[ema20.length - 1]!;
  const lastEma50 = ema50[ema50.length - 1]!;

  // Trend detection
  let trend: "UP" | "DOWN" | "RANGING" = "RANGING";
  let emaOrder = false;

  if (lastEma9 > lastEma20 && lastEma20 > lastEma50) {
    trend = "UP";
    emaOrder = true;
  } else if (lastEma9 < lastEma20 && lastEma20 < lastEma50) {
    trend = "DOWN";
    emaOrder = true;
  }

  // Trend strength (0-10): based on distance from EMAs and ADX
  const distFromEma20 = Math.abs((lastClose - lastEma20) / lastEma20) * 100;
  const strength = Math.min(
    10,
    Math.max(
      0,
      snapshot.adx14 * 0.6 +
        (emaOrder ? 1.75 : 0.75) +
        Math.min(distFromEma20 / 1.5, 2.5),
    ),
  );

  return {
    timeframe,
    snapshot,
    trend,
    strength,
    emaOrder,
  };
}

// ── Generate multi-timeframe signal ──────────────────────────────────────────

export function generateMultiTimeframeSignal(
  tf1h: TimeframeAnalysis | null,
  tf4h: TimeframeAnalysis | null,
  tfDaily: TimeframeAnalysis | null,
  tfWeekly: TimeframeAnalysis | null,
  tf1hCandles: OHLCV[],
  tf4hCandles: OHLCV[],
  // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
  _dailyCandles: OHLCV[],
): MultiTimeframeSignal {
  const dailyTrend = tfDaily?.trend ?? "RANGING";
  const weeklyTrend = tfWeekly?.trend ?? "RANGING";

  const timeframes = [
    { analysis: tf1h, weight: 1 },
    { analysis: tf4h, weight: 1.4 },
    { analysis: tfDaily, weight: 2 },
    { analysis: tfWeekly, weight: 2.4 },
  ];

  const totalWeight = timeframes.reduce(
    (sum, tf) => sum + (tf.analysis ? tf.weight : 0),
    0,
  );
  const bullishWeight = timeframes.reduce((sum, tf) => {
    if (!tf.analysis) return sum;
    const trendWeight =
      tf.analysis.trend === "UP"
        ? 1
        : tf.analysis.trend === "RANGING"
          ? 0.15
          : 0;
    const strengthWeight = 0.5 + tf.analysis.strength / 20;
    return sum + tf.weight * trendWeight * strengthWeight;
  }, 0);
  const bearishWeight = timeframes.reduce((sum, tf) => {
    if (!tf.analysis) return sum;
    const trendWeight =
      tf.analysis.trend === "DOWN"
        ? 1
        : tf.analysis.trend === "RANGING"
          ? 0.15
          : 0;
    const strengthWeight = 0.5 + tf.analysis.strength / 20;
    return sum + tf.weight * trendWeight * strengthWeight;
  }, 0);

  const bullishScore =
    totalWeight > 0 ? (bullishWeight / totalWeight) * 100 : 0;
  const bearishScore =
    totalWeight > 0 ? (bearishWeight / totalWeight) * 100 : 0;
  const confluenceScore = Math.round(Math.max(bullishScore, bearishScore));

  let direction: "BUY" | "SELL" | "NEUTRAL" = "NEUTRAL";
  if (
    bullishScore >= 60 &&
    bullishWeight > bearishWeight * 1.15 &&
    tfDaily?.trend !== "DOWN" &&
    tfWeekly?.trend !== "DOWN"
  ) {
    direction = "BUY";
  } else if (
    bearishScore >= 60 &&
    bearishWeight > bullishWeight * 1.15 &&
    tfDaily?.trend !== "UP" &&
    tfWeekly?.trend !== "UP"
  ) {
    direction = "SELL";
  }

  // Hourly confirmation
  const hourlyConfirm =
    (direction === "BUY" &&
      tf1h?.trend === "UP" &&
      (tf4h?.trend === "UP" || tf4h?.trend === "RANGING")) ||
    (direction === "SELL" &&
      tf1h?.trend === "DOWN" &&
      (tf4h?.trend === "DOWN" || tf4h?.trend === "RANGING"));

  // Crossover signals
  const crossover1h =
    tf1h && direction !== "NEUTRAL"
      ? isCrossingEma20(tf1hCandles, tf1h.snapshot, direction)
      : false;
  const crossover4h =
    tf4h && direction !== "NEUTRAL"
      ? isCrossingEma20(tf4hCandles, tf4h.snapshot, direction)
      : false;

  // Volume increase on move
  const volumeIncrease =
    direction === "BUY"
      ? [tf1h, tf4h, tfDaily].some((tf) =>
          Boolean(tf && tf.trend === "UP" && tf.snapshot.volumeRatio > 1.25),
        )
      : direction === "SELL"
        ? [tf1h, tf4h, tfDaily].some((tf) =>
            Boolean(tf && tf.trend === "DOWN" && tf.snapshot.volumeRatio > 1.25),
          )
        : false;

  const mtf_total = timeframes.filter((tf) => tf.analysis).length;
  const mtf_score = timeframes.filter((tf) => {
    if (!tf.analysis) return false;
    if (direction === "BUY") return tf.analysis.trend === "UP";
    if (direction === "SELL") return tf.analysis.trend === "DOWN";
    return false;
  }).length;

  let mtf_confluence: 'STRONG ALIGN' | 'PARTIAL' | 'DIVERGING' | 'PENDING' = 'PENDING';
  if (mtf_total > 0) {
    const ratio = mtf_score / mtf_total;
    if (ratio >= 0.8) mtf_confluence = 'STRONG ALIGN';
    else if (ratio >= 0.5) mtf_confluence = 'PARTIAL';
    else mtf_confluence = 'DIVERGING';
  }

  return {
    direction,
    dailyTrend,
    weeklyTrend,
    hourlyConfirm,
    confluenceScore: Math.round(confluenceScore),
    crossover1h,
    crossover4h,
    volumeIncrease,
    mtf_score,
    mtf_total,
    mtf_confluence,
  };
}

// ── EMA 20 crossover detection ───────────────────────────────────────────────

function isCrossingEma20(
  candles: OHLCV[],
  snapshot: TechnicalSnapshot,
  direction: "BUY" | "SELL",
): boolean {
  if (candles.length < 2) return false;

  const lastClose = candles[candles.length - 1]!.close;
  const previousClose = candles[candles.length - 2]!.close;
  const ema20 = snapshot.ema20;

  if (direction === "BUY") {
    return previousClose <= ema20 && lastClose > ema20;
  }

  return previousClose >= ema20 && lastClose < ema20;
}

// ── Main: Analyze stock across all timeframes ────────────────────────────────

export async function analyzeMultiTimeframe(
  instrumentKey: string,
  toDate?: string,
): Promise<{
  analyses: Record<Timeframe, TimeframeAnalysis | null>;
  signal: MultiTimeframeSignal;
}> {
  const data = await fetchMultiTimeframeData(instrumentKey, toDate);

  const tf1h = analyzeTimeframe(data.tf1h, "1h");
  const tf4h = analyzeTimeframe(data.tf4h, "4h");
  const tfDaily = analyzeTimeframe(data.tfDaily, "daily");
  const tfWeekly = analyzeTimeframe(data.tfWeekly, "weekly");

  const signal = generateMultiTimeframeSignal(
    tf1h,
    tf4h,
    tfDaily,
    tfWeekly,
    data.tf1h,
    data.tf4h,
    data.tfDaily,
  );

  return {
    analyses: {
      "1h": tf1h,
      "4h": tf4h,
      daily: tfDaily,
      weekly: tfWeekly,
    },
    signal,
  };
}

export function analyzeMultiTimeframeFromData(data: MultiTimeframeData): {
  analyses: Record<Timeframe, TimeframeAnalysis | null>;
  signal: MultiTimeframeSignal;
} {
  const tf1h = analyzeTimeframe(data.tf1h, "1h");
  const tf4h = analyzeTimeframe(data.tf4h, "4h");
  const tfDaily = analyzeTimeframe(data.tfDaily, "daily");
  const tfWeekly = analyzeTimeframe(data.tfWeekly, "weekly");

  const signal = generateMultiTimeframeSignal(
    tf1h,
    tf4h,
    tfDaily,
    tfWeekly,
    data.tf1h,
    data.tf4h,
    data.tfDaily,
  );

  return {
    analyses: {
      "1h": tf1h,
      "4h": tf4h,
      daily: tfDaily,
      weekly: tfWeekly,
    },
    signal,
  };
}
