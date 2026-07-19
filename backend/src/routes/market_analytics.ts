import { Router } from "express";
import { findStockBySymbol, fetchNiftyDailyCandles, resolveSymbolInsightContext } from "../analysis/stock_scanner";
import { inferSymbolForecast } from "../analysis/ai_client";
import { getLastRegimeOutput } from "../analysis/regime_detector";
import { getMonitoringStatus } from "../analysis/intraday_monitor";
import { getAccessToken } from "../upstox/auth";
import { logger } from "../lib/logger";
import { logApiError } from "../lib/api-errors";
import { db, learningMetricsTable } from "../../db/src/index.js";
import { desc, eq } from "drizzle-orm";
import { resolveIndexAsStock } from "./market_utils";
import type { UniverseStock } from "../analysis/stock_scanner";

const router = Router();

type AnalyticsCacheEntry<T> = {
  expiresAt: number;
  value?: T;
  inFlight?: Promise<T>;
};

const analyticsCache = new Map<string, AnalyticsCacheEntry<unknown>>();

async function getCachedAnalytics<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = analyticsCache.get(key) as AnalyticsCacheEntry<T> | undefined;
  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const inFlight = load()
    .then((value) => {
      analyticsCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .catch((err) => {
      analyticsCache.delete(key);
      throw err;
    });

  analyticsCache.set(key, { inFlight, expiresAt: now + ttlMs });
  return inFlight;
}

const FORECAST_CACHE_TTL_MS = 2 * 60 * 1000;
const SYMBOL_INSIGHTS_CACHE_TTL_MS = 60 * 1000;
// Stale-while-revalidate window: an expired insights payload up to this old is
// served INSTANTLY while a fresh compute (two Upstox candle fetches + a Python
// AI inference — seconds of latency) runs in the background. Panel loads feel
// immediate; freshness converges one request later.
const SYMBOL_INSIGHTS_STALE_MAX_MS = 15 * 60 * 1000;
const insightsRefreshInFlight = new Set<string>();

// GET /api/market/forecast?symbol=TCS
router.get("/market/forecast", async (req, res) => {
  try {
    const rawSymbol = String(req.query.symbol ?? "").trim().toUpperCase();
    if (!rawSymbol) {
      res.status(400).json({ error: "symbol is required" });
      return;
    }

    const token = getAccessToken();
    if (!token) {
      res.status(401).json({ error: "Upstox authentication required" });
      return;
    }

    const stock = resolveIndexAsStock(rawSymbol) || await findStockBySymbol(rawSymbol);
    if (!stock) {
      res.status(200).json({
        symbol: rawSymbol,
        available: false,
        error: `Symbol ${rawSymbol} not found in universe`,
      });
      return;
    }

    const payload = await getCachedAnalytics(
      `forecast:${stock.symbol}`,
      FORECAST_CACHE_TTL_MS,
      async () => {
        const niftyCandles = await fetchNiftyDailyCandles(70);
        const context = await resolveSymbolInsightContext(stock as UniverseStock, niftyCandles, true);
        if (!context?.candles.length) {
          return {
            symbol: stock.symbol,
            available: false,
            error: "Insufficient candle history for forecast",
          };
        }

        const ai = await inferSymbolForecast(stock.symbol, context.candles, {
          rs60: context.rs60,
          mtfConfluenceScore: context.scan?.mtfConfluenceScore,
          setupType: context.scan?.setup.setupType,
        });

        if (!ai) {
          return {
            error: "AI forecast service unavailable",
            available: false,
            symbol: stock.symbol,
          };
        }

        const lastClose = context.candles[context.candles.length - 1]?.close ?? null;
        const isFallback = Boolean(
          ai.isFallback ||
          ai.chronos?.source === "fallback" ||
          ai.technicalRanking?.source === "fallback" ||
          ai.technicalRanking?.source === "Advanced Stochastic Engine" ||
          ai.chronos?.source === "error" ||
          ai.technicalRanking?.source === "error"
        );

        return {
          symbol: stock.symbol,
          available: true,
          source: ai.chronos?.source || "unknown",
          isFallback,
          trend: ai.chronos?.trend || "neutral",
          forecastReturnPct: ai.chronos?.forecast_return_pct || 0,
          medianForecast: ai.chronos?.median_forecast || [],
          quantileForecasts: ai.chronos?.quantile_forecasts || {},
          worldSentiment: ai.world_sentiment_score || 0,
          compositeScore: ai.composite_score,
          components: ai.components || {},
          lastClose,
          fetchedAt: new Date().toISOString(),
        };
      },
    );

    if (!payload.available && payload.error === "AI forecast service unavailable") {
      res.status(503).json(payload);
      return;
    }

    res.json(payload);
  } catch (err: unknown) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to generate forecast", available: false });
  }
});

// GET /api/market/symbol-insights?symbol=TCS
router.get("/market/symbol-insights", async (req, res) => {
  try {
    const rawSymbol = String(req.query.symbol ?? "").trim().toUpperCase();
    if (!rawSymbol) {
      res.status(400).json({ error: "symbol is required" });
      return;
    }

    const token = getAccessToken();
    if (!token) {
      res.status(401).json({ error: "Upstox authentication required" });
      return;
    }

    const stock = resolveIndexAsStock(rawSymbol) || await findStockBySymbol(rawSymbol);
    logger.info({ route: "symbolInsights", requestedRawSymbol: req.query.symbol, rawSymbol, resolvedStock: stock?.symbol, resolvedKey: stock?.key }, "Tracing symbolInsights request for Data Integrity Bug");

    if (!stock) {
      res.status(200).json({
        symbol: rawSymbol,
        name: rawSymbol,
        sector: "",
        scan: null,
        indicators: null,
        monitoring: null,
        ai: null,
        fetchedAt: new Date().toISOString(),
        error: `Symbol ${rawSymbol} not found in universe`,
      });
      return;
    }

    const insightsCacheKey = `symbol-insights:${stock.symbol}`;
    const cachedInsights = analyticsCache.get(insightsCacheKey);
    const nowMs = Date.now();
    if (cachedInsights?.value !== undefined) {
      if (cachedInsights.expiresAt > nowMs) {
        res.json(cachedInsights.value);
        return;
      }
      // Stale-while-revalidate: answer from the last computed payload right
      // away and refresh in the background (single-flight per symbol).
      if (nowMs - cachedInsights.expiresAt < SYMBOL_INSIGHTS_STALE_MAX_MS) {
        res.json(cachedInsights.value);
        if (!insightsRefreshInFlight.has(insightsCacheKey)) {
          insightsRefreshInFlight.add(insightsCacheKey);
          void computeSymbolInsights(stock)
            .then((payload) => {
              analyticsCache.set(insightsCacheKey, { value: payload, expiresAt: Date.now() + SYMBOL_INSIGHTS_CACHE_TTL_MS });
            })
            .catch((err) => logger.warn({ err, symbol: stock.symbol }, "Background symbol-insights refresh failed"))
            .finally(() => insightsRefreshInFlight.delete(insightsCacheKey));
        }
        return;
      }
    }

    const payload = await computeSymbolInsights(stock);
    analyticsCache.set(insightsCacheKey, {
      value: payload,
      expiresAt: Date.now() + SYMBOL_INSIGHTS_CACHE_TTL_MS,
    });
    res.json(payload);
  } catch (err: unknown) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to load symbol insights" });
  }
});

type ResolvedStock = NonNullable<ReturnType<typeof resolveIndexAsStock>> | UniverseStock;

async function computeSymbolInsights(stock: ResolvedStock) {
    const niftyCandles = await fetchNiftyDailyCandles(70);
    const context = await resolveSymbolInsightContext(stock, niftyCandles, true);
    const monitoring = getMonitoringStatus().monitoredStocks.find(
      (row) => row.symbol === stock.symbol,
    );

    let ai: Awaited<ReturnType<typeof inferSymbolForecast>> = null;
    if (context?.candles.length) {
      ai = await inferSymbolForecast(stock.symbol, context.candles, {
        rs60: context.rs60,
        mtfConfluenceScore: context.scan?.mtfConfluenceScore,
        setupType: context.scan?.setup.setupType,
      });
    }

    const scanResult = context?.scan ?? null;
    const snap = context?.snapshot ?? null;
    logger.info({ route: "symbolInsights", symbol: stock.symbol, fallbackLtp: snap?.close }, "Tracing fallback LTP generated by resolveSymbolInsightContext");

    let provisional_trigger: number | null = null;
    let provisional_deviation = 0;
    
    if (snap) {
      if (scanResult?.setup.entryPrice && scanResult.setup.entryPrice > 0) {
        provisional_trigger = scanResult.setup.entryPrice;
      } else {
        const vwapDistPct = Math.abs((snap.close - snap.vwap) / snap.vwap) * 100;
        let crossedEma9 = false;
        if (context?.candles && context.candles.length >= 3) {
          const lastCandles = context.candles.slice(-3);
          for (let i = 1; i < lastCandles.length; i++) {
            const prevC = lastCandles[i-1];
            const currC = lastCandles[i];
            if (prevC && currC && ((prevC.close < snap.ema9 && currC.close > snap.ema9) || (prevC.close > snap.ema9 && currC.close < snap.ema9))) {
              crossedEma9 = true;
              break;
            }
          }
        }
        if (vwapDistPct <= 0.5) provisional_trigger = snap.vwap;
        else if (crossedEma9) provisional_trigger = snap.ema9;
        else provisional_trigger = snap.ema20;
      }
      if (provisional_trigger) {
        provisional_deviation = Number((((snap.close - provisional_trigger) / provisional_trigger) * 100).toFixed(2));
      }
    }

    const metrics: { techEdge: number | null, regimeAlign: number | null } = { techEdge: null, regimeAlign: null };
    try {
      const resData = await db.select().from(learningMetricsTable)
                          .where(eq(learningMetricsTable.symbol, stock.symbol))
                          .orderBy(desc(learningMetricsTable.updatedAt))
                          .limit(1);
      if (resData.length > 0) {
        metrics.techEdge = resData[0].techEdge ? parseFloat(resData[0].techEdge) : null;
        metrics.regimeAlign = resData[0].regimeAlign ? parseFloat(resData[0].regimeAlign) : null;
      }
    } catch {
      logger.warn({ symbol: stock.symbol }, "Failed to fetch learning metrics");
    }

    const payload = {
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      scan: scanResult
        ? {
            score: scanResult.score,
            setupType: scanResult.setup.setupType,
            direction: scanResult.setup.direction,
            mtfConfluenceScore: scanResult.mtfConfluenceScore,
            mtfScore: scanResult.mtfScore ?? 0,
            mtfTotal: scanResult.mtfTotal ?? 0,
            mtfConfluenceString: scanResult.mtfConfluenceString ?? 'PENDING',
            rs60: scanResult.rs60,
            reasoning: scanResult.setup.reasoning,
            provisional_trigger,
            provisional_deviation,
          }
        : snap
          ? {
              score: 0,
              setupType: "TECHNICAL_VIEW",
              direction: snap.trend === "UP" ? "BUY" : snap.trend === "DOWN" ? "SELL" : "WATCH",
              mtfConfluenceScore: 0,
              mtfScore: 0,
              mtfTotal: 0,
              mtfConfluenceString: 'PENDING',
              rs60: context?.rs60 ?? 1,
              reasoning: `${snap.trend} trend · RSI ${snap.rsi14.toFixed(1)} · ADX ${snap.adx14.toFixed(1)} · vol ${snap.volumeRatio.toFixed(2)}x`,
              provisional_trigger,
              provisional_deviation,
            }
          : null,
      indicators: snap
        ? {
            rsi14: snap.rsi14,
            adx14: snap.adx14,
            volumeRatio: snap.volumeRatio,
            ema9: snap.ema9,
            ema20: snap.ema20,
            trend: snap.trend,
            distFromEma20Pct: snap.distFromEma20Pct,
            close: snap.close,
          }
        : null,
      monitoring: monitoring ?? null,
      ai: ai
        ? {
            worldSentiment: ai.world_sentiment_score || 0,
            compositeScore: ai.composite_score,
            components: ai.components || {},
            trend: ai.chronos?.trend ?? "UNKNOWN",
            forecastReturnPct: ai.chronos?.forecast_return_pct ?? 0,
            technicalPatterns: ai.technicalRanking?.detected_patterns ?? [],
            source: ai.chronos?.source ?? "unknown",
            isFallback: Boolean(ai.isFallback || ai.chronos?.source === "fallback" || ai.technicalRanking?.source === "fallback" || ai.technicalRanking?.source === "Advanced Stochastic Engine" || ai.chronos?.source === "error" || ai.technicalRanking?.source === "error"),
            techEdge: metrics.techEdge ?? (ai.technicalRanking ? Math.round(ai.technicalRanking.confidence * 100) : null),
            regimeAlign: metrics.regimeAlign ?? (getLastRegimeOutput()?.strength ?? 50),
          }
        : {
            compositeScore: 0,
            trend: "UNKNOWN",
            forecastReturnPct: 0,
            technicalPatterns: [],
            source: "none",
            isFallback: false,
            techEdge: metrics.techEdge,
            regimeAlign: metrics.regimeAlign ?? (getLastRegimeOutput()?.strength ?? 50),
          },
      fetchedAt: new Date().toISOString(),
    };

    return payload;
}

export default router;
