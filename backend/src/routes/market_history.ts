import { Router } from "express";
import { findStockBySymbol } from "../analysis/stock_scanner";
import { fetchSparklines } from "../analysis/sparklines";
import { getAccessToken } from "../upstox/auth";
import { logger } from "../lib/logger";
import { getISTDateStr, shiftISTDateStr } from "../lib/ist-time";
import { logApiError } from "../lib/api-errors";
import { AxiosError } from "axios";
import { db, symbolScoresTable } from "../../db/src/index.js";
import { desc, eq } from "drizzle-orm";
import { resolveIndexAsStock, isCandleInterval, CandleInterval, upstoxClient } from "./market_utils";

const router = Router();

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

    const token = getAccessToken();
    if (!token) {
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
