import { Router } from "express";
import { getMarketState, computeSessionPhase, minutesUntilOpen } from "../market_data/market_state";
import { getMarketFeedSnapshot } from "../market_data/market_feed";
import { getMarketIntelligenceSnapshot } from "../intelligence/orchestrator";
import { findStockBySymbol, fetchNiftyDailyCandles, resolveSymbolInsightContext } from "../analysis/stock_scanner";
import { inferSymbolForecast } from "../analysis/ai_client";
import { fetchSparklines } from "../analysis/sparklines";
import { getMonitoringStatus } from "../analysis/intraday_monitor";
import { getAccessToken } from "../upstox/auth";
import { createUpstoxClient } from "../lib/upstox-client";
import { logger } from "../lib/logger";
import { getISTDateStr, getLastCompletedTradingDayStr, shiftISTDateStr } from "../lib/ist-time";
import { logApiError, sendFallback } from "../lib/api-errors";
import { getGlobalMacroState } from "../analysis/global_macro";
import { fetchFIIDIIData } from "../market_data/fii_dii";
import { fetchOptionChainData } from "../market_data/option_chain";
import axios from "axios";
import { db, overnightWatchlistTable, symbolScoresTable, learningMetricsTable } from "../../db/src/index.js";
import { desc, eq } from "drizzle-orm";

const router = Router();
const upstoxClient = createUpstoxClient({ cacheTimeMs: 15_000 });

type LiveIndexQuote = {
  keyUsed: string | null;
  ltp: number | null;
  changePct: number | null;
};

type DashboardIndices = {
  nifty50: LiveIndexQuote;
  sensex: LiveIndexQuote;
  bankNifty: LiveIndexQuote;
  finnifty: LiveIndexQuote;
  indiaVix: LiveIndexQuote;
  fetchedAt: string;
};

const INDEX_KEY_CANDIDATES = {
  nifty50: ["NSE_INDEX|Nifty 50"],
  sensex: ["BSE_INDEX|SENSEX", "BSE_INDEX|Sensex"],
  bankNifty: ["NSE_INDEX|Nifty Bank", "NSE_INDEX|NIFTY BANK"],
  finnifty: ["NSE_INDEX|Nifty Fin Service", "NSE_INDEX|NIFTY FIN SERVICE"],
  indiaVix: ["NSE_INDEX|India VIX"],
} as const;

const INDEX_SYMBOL_ALIAS: Record<string, keyof typeof INDEX_KEY_CANDIDATES> = {
  NIFTY: "nifty50",
  "NIFTY50": "nifty50",
  SENSEX: "sensex",
  BANK: "bankNifty",
  BANKNIFTY: "bankNifty",
  FINNIFTY: "finnifty",
  VIX: "indiaVix",
  INDIAVIX: "indiaVix",
};

export function resolveIndexAsStock(rawSymbol: string) {
  const cleanSym = rawSymbol.replace(/\s+/g, "").toUpperCase();
  let indexKey = null;
  let symbolLabel = rawSymbol;

  if (INDEX_SYMBOL_ALIAS[cleanSym]) {
    indexKey = INDEX_KEY_CANDIDATES[INDEX_SYMBOL_ALIAS[cleanSym]][0];
    symbolLabel = rawSymbol;
  } else if (INDEX_SYMBOL_ALIAS[rawSymbol]) {
    indexKey = INDEX_KEY_CANDIDATES[INDEX_SYMBOL_ALIAS[rawSymbol]][0];
    symbolLabel = rawSymbol;
  } else if (rawSymbol === "INDIA VIX" || cleanSym === "INDIAVIX") {
    indexKey = INDEX_KEY_CANDIDATES.indiaVix[0];
    symbolLabel = "INDIA VIX";
  } else if (rawSymbol === "NIFTY 50" || cleanSym === "NIFTY50") {
    indexKey = INDEX_KEY_CANDIDATES.nifty50[0];
    symbolLabel = "NIFTY 50";
  }

  if (indexKey) {
    return {
      symbol: symbolLabel,
      key: indexKey,
      name: symbolLabel,
      sector: "INDEX",
    };
  }
  return null;
}

const indexMetricsCache: { at: number; data: DashboardIndices | null } = {
  at: 0,
  data: null,
};

function fallbackDashboardIndices(): DashboardIndices {
  const state = getMarketState();
  return {
    nifty50: { keyUsed: state.niftyPrice == null ? null : "cached:NIFTY", ltp: state.niftyPrice, changePct: state.niftyChangePct },
    sensex: { keyUsed: null, ltp: null, changePct: null },
    bankNifty: { keyUsed: null, ltp: null, changePct: null },
    finnifty: { keyUsed: null, ltp: null, changePct: null },
    indiaVix: { keyUsed: state.indiaVix == null ? null : "cached:VIX", ltp: state.indiaVix, changePct: null },
    fetchedAt: new Date().toISOString(),
  };
}

const CANDLE_INTERVALS = [
  "1minute",
  "5minute",
  "15minute",
  "60minute",
  "240minute",
  "day",
  "week",
] as const;

type CandleInterval = (typeof CANDLE_INTERVALS)[number];

function isCandleInterval(value: string): value is CandleInterval {
  return (CANDLE_INTERVALS as readonly string[]).includes(value);
}

async function fetchIndexPrevClose(
  key: string,
  token: string,
): Promise<number | null> {
  try {
    const toDate = getLastCompletedTradingDayStr(new Date());
    const fromDate = shiftISTDateStr(toDate, -7);
    const candles = await upstoxClient.fetchHistoricalCandles(
      key,
      "day",
      toDate,
      fromDate,
      token,
    );
    if (!candles.length) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = candles[0] as any[];
    const close = Number(row[4]);
    return Number.isFinite(close) && close > 0 ? close : null;
  } catch (err) {
    logger.error({ err, key }, "Failed to fetch index previous close");
    return null;
  }
}

async function buildDashboardIndices(): Promise<DashboardIndices | null> {
  
  const computeYF = async (symbol: string): Promise<LiveIndexQuote> => {
    try {
      const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, { timeout: 4000 });
      const meta = res.data.chart?.result?.[0]?.meta;
      if (!meta) throw new Error("Invalid Yahoo Finance payload");
      
      const ltp = meta.regularMarketPrice;
      const prevClose = meta.previousClose;
      const changePct = prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : null;
      
      return {
        keyUsed: `YF:${symbol}`,
        ltp,
        changePct: changePct != null ? Number(changePct.toFixed(3)) : null,
      };
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger.warn({ symbol, err: (err as any).message }, "Failed to fetch index from Yahoo Finance");
      return { keyUsed: null, ltp: null, changePct: null };
    }
  };

  const [nifty50, sensex, bankNifty, finnifty, indiaVix] = await Promise.all([
    computeYF('^NSEI'),
    computeYF('^BSESN'),
    computeYF('^NSEBANK'),
    computeYF('^CNXFIN'),
    computeYF('^INDIAVIX')
  ]);

  const result = {
    nifty50,
    sensex,
    bankNifty,
    finnifty,
    indiaVix,
    fetchedAt: new Date().toISOString(),
  };

  logger.debug("Dashboard indices computed successfully via Yahoo Finance (Free API)");
  return result;
}

// GET /api/market/regime
router.get("/market/regime", async (_req, res) => {
  const state = getMarketState();
  const phase = computeSessionPhase();
  const marketOpen = phase === "MARKET";
  const minsUntilOpen = minutesUntilOpen();

  res.json({
    regime: state.regime,
    sessionPhase: phase,
    isMarketOpen: marketOpen,
    minutesUntilOpen: minsUntilOpen,
    indiaVix: state.indiaVix,
    niftyChange: state.niftyChangePct,
    updatedAt: state.updatedAt.toISOString(),
    suggestionsPaused: state.suggestionsPaused,
    pauseReason: state.pauseReason,
    decisionReason: state.decisionReason ?? "Calculating...",
    inputsForced: state.inputsForced ?? false,
  });
});

// GET /api/market/overview
router.get("/market/overview", async (_req, res) => {
  const state = getMarketState();
  const feed = getMarketFeedSnapshot();
  const intelligence = getMarketIntelligenceSnapshot();
  const breadth = intelligence.breadth;
  const sectorStrength = breadth?.sectorStrength ?? {};
  const topSectors = state.topSectors.length
    ? state.topSectors
    : Object.entries(sectorStrength)
        .map(([name, changePct]) => ({ name, changePct: Number(changePct) }))
        .sort((a, b) => b.changePct - a.changePct)
        .slice(0, 8);
  const phase = computeSessionPhase();
  res.json({
    niftyPrice: state.niftyPrice,
    niftyChangePct: state.niftyChangePct,
    advanceCount: state.advanceCount || breadth?.advancers || 0,
    declineCount: state.declineCount || breadth?.decliners || 0,
    topSectors,
    fiiNetInr: state.fiiNetInr,
    diiNetInr: state.diiNetInr,
    isMarketOpen: phase === "MARKET",
    marketOpenTime: "09:15",
    marketCloseTime: "15:30",
    upstoxFeed: feed,
  });
});

// GET /api/market/dashboard-indices
// Real index quotes + daily change for dashboard ticker.
router.get("/market/dashboard-indices", async (req, res) => {
  const respondDegraded = (reason: string, payload: DashboardIndices) => {
    res.setHeader("X-UpstoxBot-Degraded", reason);
    res.json({ ...payload, degraded: true, reason });
  };

  try {
    const now = Date.now();
    if (indexMetricsCache.data && now - indexMetricsCache.at < 30_000) {
      res.json(indexMetricsCache.data);
      return;
    }

    const data = await buildDashboardIndices();
    if (!data) {
      respondDegraded("no-auth", fallbackDashboardIndices());
      return;
    }

    indexMetricsCache.at = now;
    indexMetricsCache.data = data;
    res.json(data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logApiError(req, err);
    const status = err.response?.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errData = err.response?.data as any;
    const isAuthErr =
      status === 401 ||
      status === 403 ||
      errData?.errors?.[0]?.errorCode === "UDAPI100050" ||
      (typeof err.message === "string" && err.message.includes("UDAPI100050")) ||
      (typeof errData?.errors?.[0]?.message === "string" && errData.errors[0].message.toLowerCase().includes("invalid token"));

    if (isAuthErr) {
      respondDegraded("auth-invalid", fallbackDashboardIndices());
      return;
    }
    respondDegraded("dashboard-indices-error", fallbackDashboardIndices());
  }
});

// GET /api/market/indian-context
router.get("/market/indian-context", async (_req, res) => {
  const fiiDii = await fetchFIIDIIData();
  const optionChain = await fetchOptionChainData();
  const macroData = getGlobalMacroState();

  res.json({
    fiiDii: fiiDii,
    niftyOptionChain: optionChain,
    usdInr: macroData.usdInr,
    india10y: macroData.india10y,
    macroScore: macroData.macroScore,
    eventRiskActive: macroData.eventRiskActive,
    lastUpdated: new Date().toISOString()
  });
});

// GET /api/market/ltp?symbol=TCS
router.get("/market/ltp", async (req, res) => {
  try {
    const rawSymbol = String(req.query.symbol ?? "").trim().toUpperCase();
    if (!rawSymbol) {
      res.status(400).json({ error: "symbol is required" });
      return;
    }

    const stock = await findStockBySymbol(rawSymbol);
    if (!stock) {
      res.status(404).json({ error: `Symbol ${rawSymbol} not found` });
      return;
    }

    const token = getAccessToken();
    if (!token) {
      res.status(401).json({ error: "Upstox authentication required" });
      return;
    }

    const prices = await upstoxClient.fetchLTPForInstruments([stock.key], token);
    let ltp = prices[stock.key] ?? null;
    let source: "ltp" | "close_fallback" = "ltp";
    if (ltp == null) {
      const asOf = getLastCompletedTradingDayStr(new Date());
      const from = shiftISTDateStr(asOf, -5);
      const candles = await upstoxClient.fetchHistoricalCandles(
        stock.key,
        "day",
        asOf,
        from,
        token,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const latest = candles[0] as any[] | undefined;
      const fallbackClose = latest ? Number(latest[4]) : NaN;
      if (Number.isFinite(fallbackClose) && fallbackClose > 0) {
        ltp = fallbackClose;
        source = "close_fallback";
      } else {
        res.status(404).json({ error: "LTP unavailable" });
        return;
      }
    }

    res.json({
      symbol: stock.symbol,
      name: stock.name,
      ltp,
      source,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    req.log.error({ err }, "Failed to fetch market ltp");
    const status = err.response?.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errData = err.response?.data as any;
    const isAuthErr =
      status === 401 ||
      status === 403 ||
      errData?.errors?.[0]?.errorCode === "UDAPI100050" ||
      (typeof err.message === "string" && err.message.includes("UDAPI100050")) ||
      (typeof errData?.errors?.[0]?.message === "string" && errData.errors[0].message.toLowerCase().includes("invalid token"));

    if (isAuthErr) {
      res.status(401).json({ error: "Upstox authentication required (Token invalid)" });
      return;
    }
    res.status(500).json({ error: "Failed to fetch ltp" });
  }
});

// GET /api/market/ltp-batch?symbols=TCS,RELIANCE,INFY
router.get("/market/ltp-batch", async (req, res) => {
  try {
    const rawSymbols = String(req.query.symbols ?? "");
    const symbols = rawSymbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 40);

    if (!symbols.length) {
      res.status(400).json({ error: "symbols is required" });
      return;
    }

    const token = getAccessToken();
    if (!token) {
      res.status(401).json({ error: "Upstox authentication required" });
      return;
    }

    const resolved = await Promise.all(
      symbols.map(async (symbol) => {
        const stock = await findStockBySymbol(symbol);
        return stock ? { symbol: stock.symbol, key: stock.key } : null;
      }),
    );
    const valid = resolved.filter((v): v is { symbol: string; key: string } => Boolean(v));
    if (!valid.length) {
      res.status(404).json({ error: "No symbols found" });
      return;
    }

    const ltpByKey = await upstoxClient.fetchLTPForInstruments(
      valid.map((s) => s.key),
      token,
    );

    const quotes = await Promise.all(
      valid.map(async (row) => {
        const ltp = ltpByKey[row.key];
        if (typeof ltp !== "number" || !Number.isFinite(ltp)) return null;
        const prevClose = await fetchIndexPrevClose(row.key, token);
        const changePct =
          prevClose && prevClose > 0
            ? Number((((ltp - prevClose) / prevClose) * 100).toFixed(2))
            : null;
        return {
          symbol: row.symbol,
          price: Number(ltp.toFixed(2)),
          changePct,
        };
      }),
    );

    const quoteMap: Record<string, { price: number; changePct: number | null }> = {};
    const prices: Record<string, number> = {};
    for (const row of quotes) {
      if (!row) continue;
      quoteMap[row.symbol] = { price: row.price, changePct: row.changePct };
      prices[row.symbol] = row.price;
    }

    res.json({ quotes: quoteMap, prices });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    req.log.error({ err }, "Failed to fetch market ltp batch");
    const status = err.response?.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errData = err.response?.data as any;
    const isAuthErr =
      status === 401 ||
      status === 403 ||
      errData?.errors?.[0]?.errorCode === "UDAPI100050" ||
      (typeof err.message === "string" && err.message.includes("UDAPI100050")) ||
      (typeof errData?.errors?.[0]?.message === "string" && errData.errors[0].message.toLowerCase().includes("invalid token"));

    if (isAuthErr) {
      res.status(401).json({ error: "Upstox authentication required (Token invalid)" });
      return;
    }
    res.status(500).json({ error: "Failed to fetch ltp batch" });
  }
});

// GET /api/market/candles?symbol=TCS&interval=5minute&lookbackDays=5
router.get("/market/candles", async (req, res) => {
  try {
    const rawSymbol = String(req.query.symbol ?? "").trim().toUpperCase();
    const intervalStr = String(req.query.interval ?? "day");
    const lookbackDays = Number(req.query.lookbackDays ?? 5);
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
      // endDateParam might be an ISO string or Date string
      const d = new Date(endDateParam);
      if (!isNaN(d.getTime())) {
        toDateStr = getISTDateStr(d);
      }
    }
    const toDate = toDateStr;
    const fromDate = shiftISTDateStr(toDate, -Math.max(1, lookbackDays));

    const rawCandles = await upstoxClient.fetchHistoricalCandles(
      stock.key,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      intervalStr as any,
      toDate,
      fromDate,
      token
    );

    logger.debug(`[market.ts] fetchHistoricalCandles for ${stock.key} interval=${intervalStr} returned ${rawCandles.length} candles`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formatted = rawCandles.map((c: any) => ({
      ts: c[0],
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
    })).reverse();

    res.json({ candles: formatted, symbol: stock.symbol });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logApiError(req, err);
    const status = err.response?.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errData = err.response?.data as any;
    const isAuthErr =
      status === 401 ||
      status === 403 ||
      errData?.errors?.[0]?.errorCode === "UDAPI100050" ||
      (typeof err.message === "string" && err.message.includes("UDAPI100050")) ||
      (typeof errData?.errors?.[0]?.message === "string" && errData.errors[0].message.toLowerCase().includes("invalid token"));

    if (isAuthErr) {
      res.status(401).json({ error: "Upstox authentication required (Token invalid)" });
      return;
    }
    res.status(500).json({ error: "Failed to fetch candles from Upstox" });
  }
});

// GET /api/market/movers — top gainers and losers from watchlist
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moversCache: { at: number; data: any } = { at: 0, data: null };

router.get("/market/movers", async (req, res) => {
  try {
    const now = Date.now();
    if (moversCache.data && now - moversCache.at < 30_000) {
      res.json(moversCache.data);
      return;
    }

    const token = getAccessToken();
    if (!token) {
      res.status(401).json({ error: "Upstox authentication required" });
      return;
    }

    // Import DB utilities lazily
    // DB utilities imported at top level

    // Get today's watchlist stocks
    const today = getISTDateStr();
    let rows = await db
      .select({ symbol: overnightWatchlistTable.symbol })
      .from(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, today))
      .orderBy(desc(overnightWatchlistTable.priority))
      .limit(20);

    // Fallback to latest available watchlist
    if (rows.length === 0) {
      const [latest] = await db
        .select({ forDate: overnightWatchlistTable.forDate })
        .from(overnightWatchlistTable)
        .orderBy(desc(overnightWatchlistTable.forDate))
        .limit(1);
      if (latest?.forDate) {
        rows = await db
          .select({ symbol: overnightWatchlistTable.symbol })
          .from(overnightWatchlistTable)
          .where(eq(overnightWatchlistTable.forDate, latest.forDate))
          .orderBy(desc(overnightWatchlistTable.priority))
          .limit(20);
      }
    }

    if (rows.length === 0) {
      const data = { gainers: [], losers: [] };
      moversCache.at = now;
      moversCache.data = data;
      res.json(data);
      return;
    }

    // Resolve instrument keys
    const resolved = await Promise.all(
      rows.map(async ({ symbol }) => {
        const stock = await findStockBySymbol(symbol);
        return stock ? { symbol: stock.symbol, key: stock.key } : null;
      }),
    );
    const valid = resolved.filter(
      (v): v is { symbol: string; key: string } => Boolean(v),
    );

    if (valid.length === 0) {
      const data = { gainers: [], losers: [] };
      moversCache.at = now;
      moversCache.data = data;
      res.json(data);
      return;
    }

    // Fetch LTPs
    const ltpByKey = await upstoxClient.fetchLTPForInstruments(
      valid.map((s) => s.key),
      token,
    );

    // Fetch previous closes in parallel
    const movers = await Promise.all(
      valid.map(async (stock) => {
        const ltp = ltpByKey[stock.key];
        if (typeof ltp !== "number" || !Number.isFinite(ltp)) return null;

        const prevClose = await fetchIndexPrevClose(stock.key, token);
        if (!prevClose || prevClose <= 0) return null;

        const changePct = ((ltp - prevClose) / prevClose) * 100;
        return {
          symbol: stock.symbol,
          price: Number(ltp.toFixed(2)),
          changePct: Number(changePct.toFixed(2)),
        };
      }),
    );

    const validMovers = movers.filter(
      (m): m is { symbol: string; price: number; changePct: number } =>
        Boolean(m),
    );

    const sorted = [...validMovers].sort((a, b) => b.changePct - a.changePct);
    const data = {
      gainers: sorted.filter((m) => m.changePct > 0).slice(0, 5),
      losers: sorted
        .filter((m) => m.changePct < 0)
        .sort((a, b) => a.changePct - b.changePct)
        .slice(0, 5),
    };

    moversCache.at = now;
    moversCache.data = data;
    res.json(data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logApiError(req, err);
    const status = err.response?.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errData = err.response?.data as any;
    const isAuthErr =
      status === 401 ||
      status === 403 ||
      errData?.errors?.[0]?.errorCode === "UDAPI100050" ||
      (typeof err.message === "string" && err.message.includes("UDAPI100050")) ||
      (typeof errData?.errors?.[0]?.message === "string" && errData.errors[0].message.toLowerCase().includes("invalid token"));

    if (isAuthErr) {
      res.status(401).json({ error: "Upstox authentication required (Token invalid)" });
      return;
    }
    sendFallback(res, { gainers: [], losers: [] }, "movers-error");
  }
});

// GET /api/market/forecast?symbol=TCS — Chronos/Kronos AI forecast from live candles
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const context = await resolveSymbolInsightContext(stock as any, niftyCandles, true);
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
    const isFallback = Boolean(ai.isFallback || ai.chronos.source === "fallback" || ai.kronos.source === "fallback" || ai.kronos.source === "Advanced Stochastic Engine" || ai.chronos.source === "error" || ai.kronos.source === "error");
    res.json({
      symbol: stock.symbol,
      available: true,
      source: ai.chronos.source,
      isFallback,
      trend: ai.chronos.trend,
      forecastReturnPct: ai.chronos.forecast_return_pct,
      medianForecast: ai.chronos.median_forecast,
      quantileForecasts: ai.chronos.quantile_forecasts,
      kronos: ai.kronos,
      compositeScore: ai.composite_score,
      lastClose,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to generate forecast", available: false });
  }
});

// GET /api/market/symbol-insights?symbol=TCS — live scan + indicators for UI panel
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
            compositeScore: ai.composite_score,
            trend: ai.chronos.trend,
            forecastReturnPct: ai.chronos.forecast_return_pct,
            kronosPatterns: ai.kronos.detected_patterns,
            source: ai.chronos.source,
            isFallback: Boolean(ai.isFallback || ai.chronos.source === "fallback" || ai.kronos.source === "fallback" || ai.kronos.source === "Advanced Stochastic Engine" || ai.chronos.source === "error" || ai.kronos.source === "error"),
            techEdge: metrics.techEdge,
            regimeAlign: metrics.regimeAlign,
          }
        : {
            compositeScore: 0,
            trend: "UNKNOWN",
            forecastReturnPct: 0,
            kronosPatterns: [],
            source: "none",
            isFallback: false,
            techEdge: metrics.techEdge,
            regimeAlign: metrics.regimeAlign,
          },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to load symbol insights" });
  }
});

// GET /api/market/macro
router.get("/market/macro", (req, res) => {
  try {
    const macroState = getGlobalMacroState();
    res.json(macroState);
  } catch (err) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to fetch macro state" });
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
      .slice(0, 50); // Limit to 50 to prevent abuse

    if (!symbols.length) {
      res.status(400).json({ error: "symbols is required" });
      return;
    }

    const data = await fetchSparklines(symbols);
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch sparklines");
    res.status(500).json({ error: "Failed to fetch sparklines" });
  }
});

// GET /api/market/score-history/:symbol
router.get("/market/score-history/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params.symbol).toUpperCase();
    
    // Fetch last 7 days of scores
    const history = await db
      .select({ score: symbolScoresTable.score, date: symbolScoresTable.forDate })
      .from(symbolScoresTable)
      .where(eq(symbolScoresTable.symbol, symbol))
      .orderBy(desc(symbolScoresTable.forDate))
      .limit(7);
      
    // Return in chronological order for sparkline (oldest to newest)
    history.reverse();
    
    res.json({
      symbol,
      history: history.map(h => h.score)
    });
  } catch (err) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to fetch score history" });
  }
});

export default router;
