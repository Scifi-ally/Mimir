import { Router } from "express";
import { findStockBySymbol } from "../analysis/stock_scanner";
import { fetchSparklines } from "../analysis/sparklines";
import { getAccessToken } from "../upstox/auth";
import { logger } from "../lib/logger";
import { getISTDateStr, shiftISTDateStr } from "../lib/ist-time";
import { logApiError } from "../lib/api-errors";
import { AxiosError } from "axios";
import { db, symbolScoresTable, candlesTable } from "../../db/src/index.js";
import { desc, eq, and, gte, asc } from "drizzle-orm";
import { resolveIndexAsStock, isCandleInterval, CandleInterval, upstoxClient } from "./market_utils";

const router = Router();

/**
 * Read candles from the persistent `candles` cache.
 *
 * Used as the fallback when Upstox is not authorized, so the dashboard can still
 * render real history instead of empty charts. Returns null when the cache has
 * nothing for that key, so the caller can still answer 401.
 */
async function readCachedCandles(
  instrumentKey: string,
  interval: string,
  lookbackDays: number,
  endDateParam?: string
): Promise<{ candles: Array<{ ts: string; open: number; high: number; low: number; close: number; volume: number }>; symbol: string } | null> {
  try {
    let toDateStr = getISTDateStr(new Date());
    if (endDateParam) {
      const d = new Date(endDateParam);
      if (!isNaN(d.getTime())) toDateStr = getISTDateStr(d);
    }
    const fromDate = shiftISTDateStr(toDateStr, -Math.max(1, lookbackDays));

    const rows = await db
      .select()
      .from(candlesTable)
      .where(
        and(
          eq(candlesTable.instrumentKey, instrumentKey),
          eq(candlesTable.interval, interval),
          gte(candlesTable.timestamp, new Date(`${fromDate}T00:00:00Z`))
        )
      )
      .orderBy(asc(candlesTable.timestamp));

    if (rows.length === 0) return null;

    return {
      symbol: instrumentKey,
      candles: rows.map((r) => ({
        ts: r.timestamp.toISOString(),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      })),
    };
  } catch (err) {
    logger.warn({ err, instrumentKey, interval }, "Candle cache fallback failed");
    return null;
  }
}

type MarketHistoryCacheEntry<T> = {
  expiresAt: number;
  value?: T;
  inFlight?: Promise<T>;
};

const marketHistoryCache = new Map<string, MarketHistoryCacheEntry<unknown>>();

// Keys embed the request date range, so stale keys are never re-requested and
// would otherwise accumulate for the life of the process. Sweep periodically.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of marketHistoryCache) {
    if (entry.expiresAt <= now && !entry.inFlight) marketHistoryCache.delete(key);
  }
}, 10 * 60 * 1000).unref();

async function getCachedMarketHistory<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = marketHistoryCache.get(key) as MarketHistoryCacheEntry<T> | undefined;
  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const inFlight = load()
    .then((value) => {
      marketHistoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .catch((err) => {
      marketHistoryCache.delete(key);
      throw err;
    });

  marketHistoryCache.set(key, { inFlight, expiresAt: now + ttlMs });
  return inFlight;
}

const CANDLES_CACHE_TTL_MS = 60 * 1000;
const SPARKLINES_CACHE_TTL_MS = 5 * 60 * 1000;

// GET /api/market/candles?symbol=TCS&interval=5minute&lookbackDays=5
router.get("/market/candles", async (req, res) => {
  // Hoisted so the catch block can fall back to the candle cache on an auth
  // error, which needs the same lookup context the happy path resolved.
  let cacheCtx: { key: string; interval: string; lookbackDays: number; endDate?: string } | null = null;
  try {
    const rawSymbol = String(req.query.symbol ?? "").trim().toUpperCase();
    const intervalStr = String(req.query.interval ?? "day");
    const rawLookback = Number(req.query.lookbackDays ?? 5);
    // Non-numeric input yields NaN, which survives Math.max and produces an
    // Invalid Date in shiftISTDateStr — clamp to a sane window instead.
    const lookbackDays = Number.isFinite(rawLookback)
      ? Math.min(Math.max(Math.trunc(rawLookback), 1), 365)
      : 5;
    const endDateParam = req.query.endDate ? String(req.query.endDate) : undefined;

    if (!rawSymbol) {
      res.status(400).json({ error: "symbol is required" });
      return;
    }

    if (!isCandleInterval(intervalStr)) {
      res.status(400).json({ error: "invalid interval" });
      return;
    }

    const stock = resolveIndexAsStock(rawSymbol) || await findStockBySymbol(rawSymbol);
    if (!stock) {
      res.status(404).json({ error: `Symbol ${rawSymbol} not found` });
      return;
    }
    cacheCtx = { key: stock.key, interval: intervalStr, lookbackDays, endDate: endDateParam };

    const token = getAccessToken();
    if (!token) {
      // The `candles` table is a persistent cache of exactly this data, and it
      // is routinely populated (bulk backfills, and every earlier scan). With no
      // Upstox token the route used to answer 401 unconditionally, throwing away
      // usable history and leaving charts permanently blank. Serve the cache and
      // label it, so the UI can render real candles while being honest that they
      // are not live.
      const cached = await readCachedCandles(stock.key, intervalStr, lookbackDays, endDateParam);
      if (cached) {
        res.json({ ...cached, source: "cache" });
        return;
      }
      res.status(401).json({ error: "Upstox authentication required" });
      return;
    }

    let toDateStr = getISTDateStr(new Date());
    if (endDateParam) {
      const d = new Date(endDateParam);
      if (!isNaN(d.getTime())) {
        toDateStr = getISTDateStr(d);
      }
    }
    const toDate = toDateStr;
    const fromDate = shiftISTDateStr(toDate, -Math.max(1, lookbackDays));

    const payload = await getCachedMarketHistory(
      `candles:${stock.key}:${intervalStr}:${fromDate}:${toDate}`,
      CANDLES_CACHE_TTL_MS,
      async () => {
        const rawCandles = await upstoxClient.fetchHistoricalCandles(
          stock.key,
          intervalStr as CandleInterval,
          toDate,
          fromDate,
          token
        );

        logger.debug(`[market.ts] fetchHistoricalCandles for ${stock.key} interval=${intervalStr} returned ${rawCandles.length} candles`);

        const formatted = rawCandles.map((c) => {
          const row = c as [string, number, number, number, number, number];
          return {
            ts: row[0],
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5]),
          };
        }).reverse();

        return { candles: formatted, symbol: stock.symbol };
      },
    );

    res.json(payload);
  } catch (err: unknown) {
    logApiError(req, err);
    let isAuthErr = false;
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      const errData = err.response?.data as { errors?: Array<{ errorCode?: string; message?: string }> } | undefined;
      isAuthErr =
        status === 401 ||
        status === 403 ||
        errData?.errors?.[0]?.errorCode === "UDAPI100050" ||
        (typeof err.message === "string" && err.message.includes("UDAPI100050")) ||
        (typeof errData?.errors?.[0]?.message === "string" && errData.errors[0].message.toLowerCase().includes("invalid token"));
    }

    if (isAuthErr) {
      // A token that has gone stale mid-session behaves like no token at all:
      // fall back to the cache instead of blanking the UI.
      const cached = cacheCtx
        ? await readCachedCandles(cacheCtx.key, cacheCtx.interval, cacheCtx.lookbackDays, cacheCtx.endDate)
        : null;
      if (cached) {
        res.json({ ...cached, source: "cache" });
        return;
      }
      res.status(401).json({ error: "Upstox authentication required (Token invalid)" });
      return;
    }
    res.status(500).json({ error: "Failed to fetch candles from Upstox" });
  }
});

// GET /api/market/sparklines?symbols=RELIANCE,TCS
router.get("/market/sparklines", async (req, res) => {
  try {
    const rawSymbols = String(req.query.symbols ?? "");
    const symbols = rawSymbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 50);

    if (!symbols.length) {
      res.status(400).json({ error: "symbols is required" });
      return;
    }

    const cacheKey = `sparklines:${[...symbols].sort().join(",")}`;
    const data = await getCachedMarketHistory(
      cacheKey,
      SPARKLINES_CACHE_TTL_MS,
      () => fetchSparklines(symbols),
    );
    res.json(data);
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to fetch sparklines");
    res.status(500).json({ error: "Failed to fetch sparklines" });
  }
});

// GET /api/market/score-history/:symbol
router.get("/market/score-history/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params.symbol).toUpperCase();
    
    const history = await db
      .select({ score: symbolScoresTable.score, date: symbolScoresTable.forDate })
      .from(symbolScoresTable)
      .where(eq(symbolScoresTable.symbol, symbol))
      .orderBy(desc(symbolScoresTable.forDate))
      .limit(7);
      
    history.reverse();
    
    res.json({
      symbol,
      history: history.map(h => h.score)
    });
  } catch (err: unknown) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to fetch score history" });
  }
});

export default router;
