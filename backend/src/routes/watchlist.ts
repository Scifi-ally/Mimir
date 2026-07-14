import { Router } from "express";
import { logger } from "../lib/logger";
import { db } from "../../db/src";
import { overnightWatchlistTable, suggestionsTable } from "../../db/src";
import { desc, eq, inArray } from "drizzle-orm";
import {
  getISTDateStr,
  getNextTradingDayStr,
  getPreviousTradingDayStr,
} from "../lib/ist-time";
import { findStockBySymbol } from "../analysis/stock_scanner";
import { createUpstoxClient } from "../lib/upstox-client";
import { getAccessToken } from "../upstox/auth";
import { logApiError, sendFallback } from "../lib/api-errors";

import { getMonitoringStatus } from "../analysis/intraday_monitor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveIndicatorStatus(item: any, mon: any, sug: any) {
  if (sug?.signalFactors && typeof sug.signalFactors === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = sug.signalFactors as any;
    const parts = [];
    if (f.technical?.rsi?.value != null) parts.push(`RSI ${f.technical.rsi.value}`);
    if (f.technical?.volume?.ratio != null) parts.push(`Vol ${f.technical.volume.ratio}x`);
    if (f.relativeStrength?.value != null) parts.push(`RS ${f.relativeStrength.value}x`);
    if (parts.length) return parts.join(" · ");
  }
  if (mon?.signalGenerated) return "Signal confirmed";
  return item.condition || item.category.replaceAll("_", " ");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveSuggestionLabel(sug: any, mon: any) {
  if (sug?.status === "ACTIVE") return sug.direction;
  if (mon?.signalGenerated) return "WATCH";
  return "HOLD";
}

const router = Router();
const upstoxClient = createUpstoxClient({ cacheTimeMs: 15_000 });

// In-memory cache for enriched watchlist data
const enrichedCache = new Map<string, { data: ReturnType<typeof emptyWatchlist> | Record<string, unknown>; timestamp: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds cache

function emptyWatchlist(forDate = getISTDateStr()) {
  const today = getISTDateStr();
  return {
    forDate,
    isFallback: forDate !== today,
    hasScan: false,
    momentumCandidates: [],
    breakoutCandidates: [],
    gapCandidates: [],
    intradayCandidates: [],
    avoidList: [],
    generatedAt: null,
  };
}

// GET /api/watchlist/tomorrow — candidates for the next trading session
router.get("/watchlist/tomorrow", async (req, res) => {
  try {
    const tomorrow = getNextTradingDayStr();
    const items = await db
      .select()
      .from(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, tomorrow));

    res.json(await buildResponse(tomorrow, items));
  } catch (err) {
    logApiError(req, err);
    sendFallback(res, emptyWatchlist(getNextTradingDayStr()), "tomorrow-watchlist-error");
  }
});

// GET /api/watchlist/today — candidates for the current trading session (including gap plays)
router.get("/watchlist/today", async (req, res) => {
  try {
    const today = getISTDateStr();
    const noFallback = req.query.fallback === "false";

    // Try today first
    let items = await db
      .select()
      .from(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, today));
    let selectedDate = today;

    // If no items and fallback is enabled, try all fallback dates in parallel
    if (!items.length && !noFallback) {
      const previous = getPreviousTradingDayStr();
      const tomorrow = getNextTradingDayStr();

      const [previousItems, tomorrowItems, latestDate] = await Promise.all([
        db
          .select()
          .from(overnightWatchlistTable)
          .where(eq(overnightWatchlistTable.forDate, previous)),
        db
          .select()
          .from(overnightWatchlistTable)
          .where(eq(overnightWatchlistTable.forDate, tomorrow)),
        db
          .select({ forDate: overnightWatchlistTable.forDate })
          .from(overnightWatchlistTable)
          .orderBy(desc(overnightWatchlistTable.forDate))
          .limit(1),
      ]);

      // Prefer previous day over tomorrow
      if (previousItems.length > 0) {
        items = previousItems;
        selectedDate = previous;
      } else if (tomorrowItems.length > 0) {
        items = tomorrowItems;
        selectedDate = tomorrow;
      } else if (latestDate[0]?.forDate) {
        // Last resort: fetch the most recent date available
        items = await db
          .select()
          .from(overnightWatchlistTable)
          .where(eq(overnightWatchlistTable.forDate, latestDate[0].forDate));
        selectedDate = items.length ? latestDate[0].forDate : selectedDate;
      }
    }

    res.json(await buildResponse(selectedDate, items));
  } catch (err) {
    logApiError(req, err);
    sendFallback(res, emptyWatchlist(getISTDateStr()), "today-watchlist-error");
  }
});

// GET /api/watchlist/previous — candidates for the most recent completed trading day
router.get("/watchlist/previous", async (req, res) => {
  try {
    const previous = getPreviousTradingDayStr();
    const items = await db
      .select()
      .from(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, previous));

    res.json(await buildResponse(previous, items));
  } catch (err) {
    logApiError(req, err);
    sendFallback(res, emptyWatchlist(getPreviousTradingDayStr()), "previous-watchlist-error");
  }
});

// GET /api/watchlist/for?date=YYYY-MM-DD — candidates for a specific date
router.get("/watchlist/for", async (req, res) => {
  try {
    const date = String(req.query.date ?? getISTDateStr());
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
      res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
      return;
    }

    const items = await db
      .select()
      .from(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, date));

    res.json(await buildResponse(date, items));
  } catch (err) {
    logApiError(req, err);
    sendFallback(res, emptyWatchlist(String(req.query.date ?? getISTDateStr())), "watchlist-for-date-error");
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function enrichItemsWithRealPrices(
  items: (typeof overnightWatchlistTable.$inferSelect)[],
) {
  if (!items.length) return [];

  const token = getAccessToken();
  if (!token) {
    return items.map((i) => serializeItem(i));
  }

  try {
    // Resolve instrument keys in parallel
    const resolved = await Promise.all(
      items.map(async (i) => {
        const stock = await findStockBySymbol(i.symbol);
        return stock ? { symbol: i.symbol, key: stock.key } : null;
      }),
    );
    const validKeys = resolved.filter((v): v is { symbol: string; key: string } => Boolean(v));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let quotesByKey: Record<string, any> = {};
    if (validKeys.length > 0) {
      quotesByKey = await upstoxClient.fetchQuotesForInstruments(
        validKeys.map((s) => s.key),
        token,
      );
    }

    const symbols = items.map((i) => i.symbol);
    
    // Fetch active suggestions for these symbols
    const activeSuggestions = await db
      .select()
      .from(suggestionsTable)
      .where(inArray(suggestionsTable.symbol, symbols));
    const sugMap = new Map(activeSuggestions.filter(s => s.status === "ACTIVE").map((s) => [s.symbol, s]));

    // Get monitoring status
    const monMap = new Map(getMonitoringStatus().monitoredStocks.map((m) => [m.symbol, m]));

    return items.map((i) => {
      const row = validKeys.find((v) => v.symbol === i.symbol);
      const quote = row ? quotesByKey[row.key] : null;
      const price = quote?.last_price;
      const prevClose = (typeof price === 'number' && typeof quote?.net_change === 'number')
        ? price - quote.net_change
        : null;
      
      const mon = monMap.get(i.symbol);
      const sug = sugMap.get(i.symbol);
      
      const serialized = serializeItem(i);
      const indicatorStatus = deriveIndicatorStatus(serialized, mon, sug);
      const suggestionLabel = deriveSuggestionLabel(sug, mon);
      const signalGenerated = mon?.signalGenerated || false;

      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        return {
          ...serialized,
          ltp: price,
          prevClose: typeof prevClose === "number" ? prevClose : null,
          indicatorStatus,
          suggestionLabel,
          signalGenerated,
          buyAbove: null,
          stopLoss: null,
          target1: null,
          target2: null,
        };
      } else {
        return {
          ...serialized,
          ltp: null,
          prevClose: null,
          indicatorStatus,
          suggestionLabel,
          signalGenerated,
          buyAbove: null,
          stopLoss: null,
          target1: null,
          target2: null,
        };
      }
    });
  // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
  } catch (err) {
    return items.map((i) => {
      const serialized = serializeItem(i);
      const mon = getMonitoringStatus().monitoredStocks.find(m => m.symbol === i.symbol);
      return {
        ...serialized,
        indicatorStatus: deriveIndicatorStatus(serialized, mon, undefined),
        suggestionLabel: deriveSuggestionLabel(undefined, mon),
        signalGenerated: mon?.signalGenerated || false
      };
    });
  }
}

async function buildResponse(
  forDate: string,
  items: (typeof overnightWatchlistTable.$inferSelect)[],
) {
  // Check cache first
  const cacheKey = `${forDate}_${items.length}`;
  const cached = enrichedCache.get(cacheKey);
  const now = Date.now();
  
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

  const enriched = await enrichItemsWithRealPrices(items);
  const today = getISTDateStr();

  const response = {
    forDate,
    isFallback: forDate !== today,
    hasScan: items.length > 0,
    momentumCandidates: enriched.filter((i) => i.category === "MOMENTUM" || i.category === "LONG_SETUP" || i.category === "BEAR_MOMENTUM"),
    breakoutCandidates: enriched.filter((i) => i.category === "BREAKOUT_WATCH" || i.category === "BREAKDOWN_WATCH"),
    gapCandidates: enriched.filter((i) => i.category === "GAP_CANDIDATE"),
    intradayCandidates: enriched.filter(
      (i) => i.category === "INTRADAY_BUY" || i.category === "INTRADAY_SELL",
    ),
    avoidList: enriched.filter((i) => i.category === "AVOID" || i.category === "SHORT_SETUP"),
    generatedAt: items.length > 0 ? items[0]!.createdAt.toISOString() : null,
  };

  // Cache the result
  enrichedCache.set(cacheKey, { data: response, timestamp: now });
  
  // Clean up old cache entries (keep only last 10)
  if (enrichedCache.size > 10) {
    const entries = Array.from(enrichedCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    enrichedCache.delete(entries[0][0]);
  }

  return response;
}

function serializeItem(i: typeof overnightWatchlistTable.$inferSelect) {
  let parsedCondition = i.condition ?? "";
  if (parsedCondition.startsWith('{') && parsedCondition.endsWith('}')) {
    try {
      const obj = JSON.parse(parsedCondition);
      if (obj && typeof obj === 'object' && obj.pattern_name) {
        parsedCondition = `${obj.frequency} [${obj.score}]: ${obj.pattern_name}`;
      } else {
        // Just return as string if it's some other JSON
        parsedCondition = i.condition ?? "";
      }
    } catch (err) {
      logger.warn({ err }, "Suppressed error: failed to parse watchlist condition JSON");
      // fallback to string
    }
  }

  return {
    symbol: i.symbol,
    name: i.name ?? i.symbol,
    category: i.category,
    condition: parsedCondition,
    priority: i.priority,
  };
}

export default router;
