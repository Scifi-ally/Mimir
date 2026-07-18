import { Router } from "express";
import { getMarketState } from "../market_data/market_state";
import { findStockBySymbol } from "../analysis/stock_scanner";
import { getAccessToken } from "../upstox/auth";
import { logger } from "../lib/logger";
import { getISTDateStr, getLastCompletedTradingDayStr, shiftISTDateStr } from "../lib/ist-time";
import { logApiError, sendFallback } from "../lib/api-errors";
import axios, { AxiosError } from "axios";
import { desc, eq } from "drizzle-orm";
import { db, overnightWatchlistTable } from "../../db/src";
import { upstoxClient, fetchIndexPrevClose } from "./market_utils";
import { getFiiDiiDivergence, type DivergenceResult } from "../analysis/divergence_engine";
import { computeOFI } from "../analysis/order_flow";
import { getLatestPrice, getOHLC } from "../market_data/tick_feeder";
import { z } from "zod";

const router = Router();

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
  fiiDiiDivergence?: DivergenceResult | null;
  fetchedAt: string;
};

const indexMetricsCache: { at: number; data: DashboardIndices | null } = {
  at: 0,
  data: null,
};

// Last-known-good value per index, so a transient Yahoo failure for one symbol
// doesn't blank it out — we keep serving the previous real value instead. Keyed
// by the Yahoo symbol. Never seeded with fake data; only real fetched values.
const lastGoodByYfSymbol = new Map<string, { ltp: number; changePct: number | null; at: number }>();

// Maps each dashboard index to the live tick-feeder symbol name (see
// monitored_symbols.ts). The tick feeder subscribes to all 5 indices, so when
// Yahoo is unavailable we fall back to the real broker feed's last price.
const TICK_FEEDER_SYMBOLS = {
  nifty50: "NIFTY 50",
  sensex: "SENSEX",
  bankNifty: "BANKNIFTY",
  finnifty: "FINNIFTY",
  indiaVix: "INDIA VIX",
} as const;

// Pull a live quote from the tick feeder (real broker WebSocket cache). changePct
// is derived from the session open when available — honest intraday change, not a
// fabricated day change. Returns null ltp when the feed has nothing.
function tickFeederQuote(symbol: string): LiveIndexQuote {
  const ltp = getLatestPrice(symbol);
  if (ltp == null) return { keyUsed: null, ltp: null, changePct: null };
  const ohlc = getOHLC(symbol);
  const open = ohlc?.open;
  const changePct = open != null && open > 0 ? Number((((ltp - open) / open) * 100).toFixed(3)) : null;
  return { keyUsed: `feed:${symbol}`, ltp, changePct };
}

function fallbackDashboardIndices(): DashboardIndices {
  const state = getMarketState();
  // Prefer the live tick feeder (all 5 indices), then fall back to whatever the
  // aggregated market state cached for NIFTY / VIX. No hardcoded nulls anymore.
  const nifty = tickFeederQuote(TICK_FEEDER_SYMBOLS.nifty50);
  const vix = tickFeederQuote(TICK_FEEDER_SYMBOLS.indiaVix);
  return {
    nifty50: nifty.ltp != null
      ? nifty
      : { keyUsed: state.niftyPrice == null ? null : "cached:NIFTY", ltp: state.niftyPrice, changePct: state.niftyChangePct },
    sensex: tickFeederQuote(TICK_FEEDER_SYMBOLS.sensex),
    bankNifty: tickFeederQuote(TICK_FEEDER_SYMBOLS.bankNifty),
    finnifty: tickFeederQuote(TICK_FEEDER_SYMBOLS.finnifty),
    indiaVix: vix.ltp != null
      ? vix
      : { keyUsed: state.indiaVix == null ? null : "cached:VIX", ltp: state.indiaVix, changePct: null },
    fiiDiiDivergence: null,
    fetchedAt: new Date().toISOString(),
  };
}

async function buildDashboardIndices(): Promise<DashboardIndices | null> {
  // Maps Yahoo symbol -> tick-feeder symbol for the per-index feed fallback.
  const YF_TO_FEED: Record<string, string> = {
    "^NSEI": TICK_FEEDER_SYMBOLS.nifty50,
    "^BSESN": TICK_FEEDER_SYMBOLS.sensex,
    "^NSEBANK": TICK_FEEDER_SYMBOLS.bankNifty,
    "^CNXFIN": TICK_FEEDER_SYMBOLS.finnifty,
    "^INDIAVIX": TICK_FEEDER_SYMBOLS.indiaVix,
  };

  const computeYF = async (symbol: string): Promise<LiveIndexQuote> => {
    // Yahoo rejects requests with the default axios UA; a browser-like UA is
    // required or it returns empty/blocked payloads. query2 is a live mirror we
    // retry against if query1 fails.
    const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
    for (const host of hosts) {
      try {
        const res = await axios.get(`https://${host}/v8/finance/chart/${symbol}`, {
          timeout: 4000,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept": "application/json",
          },
        });
        const meta = res.data?.chart?.result?.[0]?.meta;
        if (!meta || meta.regularMarketPrice == null) throw new Error("Invalid Yahoo Finance payload");

        const ltp = meta.regularMarketPrice;
        const prevClose = meta.previousClose ?? meta.chartPreviousClose;
        const changePct = prevClose > 0 ? Number((((ltp - prevClose) / prevClose) * 100).toFixed(3)) : null;

        lastGoodByYfSymbol.set(symbol, { ltp, changePct, at: Date.now() });
        return { keyUsed: `YF:${symbol}`, ltp, changePct };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ symbol, host, err: msg }, "Failed to fetch index from Yahoo Finance");
      }
    }

    // Yahoo fully failed for this symbol. Prefer the live broker feed, then the
    // last-known-good Yahoo value (kept fresh for up to 10 minutes). Never null
    // out a value we can still source honestly.
    const feed = tickFeederQuote(YF_TO_FEED[symbol] ?? "");
    if (feed.ltp != null) return feed;

    const cached = lastGoodByYfSymbol.get(symbol);
    if (cached && Date.now() - cached.at < 10 * 60_000) {
      return { keyUsed: `YF:${symbol}:stale`, ltp: cached.ltp, changePct: cached.changePct };
    }

    return { keyUsed: null, ltp: null, changePct: null };
  };

  const [nifty50, sensex, bankNifty, finnifty, indiaVix, fiiDiiDivergence] = await Promise.all([
    computeYF('^NSEI'),
    computeYF('^BSESN'),
    computeYF('^NSEBANK'),
    computeYF('^CNXFIN'),
    computeYF('^INDIAVIX'),
    getFiiDiiDivergence().catch(() => null)
  ]);

  const result = {
    nifty50,
    sensex,
    bankNifty,
    finnifty,
    indiaVix,
    fiiDiiDivergence,
    fetchedAt: new Date().toISOString(),
  };

  logger.debug("Dashboard indices computed successfully via Yahoo Finance (Free API)");
  return result;
}

// GET /api/market/dashboard-indices
router.get("/market/dashboard-indices", async (req, res) => {
  const respondDegraded = (reason: string, payload: DashboardIndices) => {
    res.setHeader("X-Mimir-Degraded", reason);
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
      respondDegraded("auth-invalid", fallbackDashboardIndices());
      return;
    }
    respondDegraded("dashboard-indices-error", fallbackDashboardIndices());
  }
});

const OfiQuerySchema = z.object({
  symbol: z.string().min(1).max(20),
});

// GET /api/market/ofi
router.get("/market/ofi", (req, res) => {
  const result = OfiQuerySchema.safeParse(req.query);
  if (!result.success) {
    res.status(400).json({ error: "Invalid symbol parameter", details: result.error.format() });
    return;
  }
  const symbol = result.data.symbol;
  
  const ofi = computeOFI(symbol);
  res.json(ofi);
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
      
      const latest = candles[0] as [string, number, number, number, number, number] | undefined;
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
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to fetch market ltp");
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
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to fetch market ltp batch");
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
    res.status(500).json({ error: "Failed to fetch ltp batch" });
  }
});

const moversCache: { at: number; data: { gainers: Array<{symbol: string, price: number, changePct: number}>, losers: Array<{symbol: string, price: number, changePct: number}> } | null } = { at: 0, data: null };

// GET /api/market/movers
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

    const today = getISTDateStr();
    let rows = await db
      .select({ symbol: overnightWatchlistTable.symbol })
      .from(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, today))
      .orderBy(desc(overnightWatchlistTable.priority))
      .limit(20);

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

    const ltpByKey = await upstoxClient.fetchLTPForInstruments(
      valid.map((s) => s.key),
      token,
    );

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
    sendFallback(res, { gainers: [], losers: [] }, "movers-error");
  }
});

export default router;
