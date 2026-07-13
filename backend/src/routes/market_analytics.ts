import { Router } from "express";
import { findStockBySymbol, fetchNiftyDailyCandles, resolveSymbolInsightContext } from "../analysis/stock_scanner";
import { inferSymbolForecast } from "../analysis/ai_client";
import { getMonitoringStatus } from "../analysis/intraday_monitor";
import { getAccessToken } from "../upstox/auth";
import { logger } from "../lib/logger";
import { logApiError } from "../lib/api-errors";
import { db, learningMetricsTable } from "../../db/src/index.js";
import { desc, eq } from "drizzle-orm";
import { resolveIndexAsStock } from "./market_utils";
import type { UniverseStock } from "../analysis/stock_scanner";

const router = Router();

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

    const niftyCandles = await fetchNiftyDailyCandles(70);
    const context = await resolveSymbolInsightContext(stock as UniverseStock, niftyCandles, true);
    if (!context?.candles.length) {
      res.status(200).json({
        symbol: stock.symbol,
        available: false,
        error: "Insufficient candle history for forecast",
      });
      return;
    }

    const ai = await inferSymbolForecast(stock.symbol, context.candles, {
      rs60: context.rs60,
      mtfConfluenceScore: context.scan?.mtfConfluenceScore,
      setupType: context.scan?.setup.setupType,
    });

    if (!ai) {
      res.status(503).json({
        error: "AI forecast service unavailable",
        available: false,
        symbol: stock.symbol,
      });
      return;
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
    
    res.json({
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
    });
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

    const stock = await findStockBySymbol(rawSymbol);
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

    res.json({
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
            techEdge: metrics.techEdge,
            regimeAlign: metrics.regimeAlign,
          }
        : {
            compositeScore: 0,
            trend: "UNKNOWN",
            forecastReturnPct: 0,
            technicalPatterns: [],
            source: "none",
            isFallback: false,
            techEdge: metrics.techEdge,
            regimeAlign: metrics.regimeAlign,
          },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to load symbol insights" });
  }
});

export default router;
