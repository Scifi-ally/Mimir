import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/src";
import { overnightWatchlistTable, suggestionsTable, customWatchlistTable } from "../../db/src";
import { findStockBySymbol, getEffectiveUniverse, type StockSector } from "../analysis/stock_scanner";
import { MONITORING_MAX_STOCKS } from "../analysis/intraday_monitor";
import { upstoxConnectionManager } from "../intelligence/connection_manager";
import { initTickFeeder } from "./tick_feeder";
import { getISTDateStr, getLastCompletedTradingDayStr, getNextTradingDayStr } from "../lib/ist-time";
import { logger } from "../lib/logger";
import { isMarketOpen } from "./market_state";
import { createUpstoxClient } from "../lib/upstox-client";
import { getAccessToken } from "../upstox/auth";
import { broadcastMarketTicks } from "../ws/websocket_server";
import { tickDistribution } from "./tick_distribution";

const upstoxClient = createUpstoxClient({ cacheTimeMs: 15_000 });

export interface MonitoredStock {
  symbol: string;
  key: string;
  source: "watchlist" | "manual" | "suggestion";
}

const manualSymbols = new Set<string>();
let cachedWatchlistDate: string | null = null;

// Feed subscription cap — separate from MONITORING_MAX_STOCKS (analysis-cycle CPU cap).
// Upstox WS accepts 100-key batches; connection_manager already chunks by 100.
const FEED_MAX_STOCKS = Math.max(
  MONITORING_MAX_STOCKS,
  Number(process.env["FEED_MAX_STOCKS"] ?? "500"),
);

export async function addManualMonitoredSymbols(symbols: string[]): Promise<MonitoredStock[]> {
  const results: MonitoredStock[] = [];
  let added = false;
  for (const symbol of symbols) {
    const rawUpper = symbol.trim().toUpperCase();
    let stock = await findStockBySymbol(rawUpper);
    if (!stock && (rawUpper.includes("|") || rawUpper.startsWith("NSE_") || rawUpper.startsWith("BSE_"))) {
      stock = {
        symbol: rawUpper.split("|").pop() || rawUpper,
        key: rawUpper,
        name: rawUpper,
        sector: "INDEX" as StockSector,
      };
    }
    if (stock) {
      manualSymbols.add(stock.symbol);
      results.push({ symbol: stock.symbol, key: stock.key, source: "manual" });
      added = true;
    } else {
      logger.warn({ symbol }, "subscribe: symbol not in universe, no ticks will flow");
    }
  }
  if (added) {
    await syncMonitoredSubscriptions();
    const token = getAccessToken("data");
    if (token && results.length > 0) {
      void (async () => {
        try {
          const keys = results.map(r => r.key);
          const quotes = await upstoxClient.fetchQuotesForInstruments(keys, token);
          const batch: [string, number, number, number, number, number, number | null][] = [];
          for (const [key, quote] of Object.entries(quotes)) {
            const match = results.find(r => r.key === key || r.key.toLowerCase() === key.toLowerCase());
            if (match && quote && quote.last_price != null) {
              const prevClose = quote.ohlc?.close ?? (quote.last_price != null && quote.net_change != null ? quote.last_price - quote.net_change : null);
              const changePct = prevClose && prevClose > 0 
                ? Math.round(((quote.last_price - prevClose) / prevClose) * 10000) / 100 
                : (quote.change_pct ?? null);

              tickDistribution.ingestTick({
                symbol: match.symbol,
                ltp: quote.last_price,
                volume: quote.volume ?? 0,
                timestamp: Date.now(),
                prevClose: prevClose ?? undefined,
                changePercent: changePct ?? undefined,
              });
              batch.push([
                match.symbol,
                quote.last_price,
                quote.volume ?? 0,
                0,
                0,
                Date.now(),
                changePct
              ]);
            }
          }
          if (batch.length > 0) {
            broadcastMarketTicks(batch);
          }
        } catch (err) {
          logger.debug({ err }, "Failed to fetch initial quotes for manual monitored symbols");
        }
      })();
    }
  }
  return results;
}

async function loadWatchlistSymbols(limit = FEED_MAX_STOCKS): Promise<{
  symbols: string[];
  selectedDate: string | null;
}> {
  const today = getISTDateStr();
  const datesToTry = [today, getLastCompletedTradingDayStr(), getNextTradingDayStr()];

  for (const date of datesToTry) {
    const rows = await db
      .select({ symbol: overnightWatchlistTable.symbol })
      .from(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, date))
      .orderBy(desc(overnightWatchlistTable.priority))
      .limit(limit);
    if (rows.length > 0) {
      cachedWatchlistDate = date;
      return { symbols: rows.map((r) => r.symbol), selectedDate: date };
    }
  }

  const [latest] = await db
    .select({ forDate: overnightWatchlistTable.forDate })
    .from(overnightWatchlistTable)
    .orderBy(desc(overnightWatchlistTable.forDate))
    .limit(1);

  if (latest?.forDate) {
    const rows = await db
      .select({ symbol: overnightWatchlistTable.symbol })
      .from(overnightWatchlistTable)
      .where(eq(overnightWatchlistTable.forDate, latest.forDate))
      .orderBy(desc(overnightWatchlistTable.priority))
      .limit(limit);
    cachedWatchlistDate = latest.forDate;
    return { symbols: rows.map((r) => r.symbol), selectedDate: latest.forDate };
  }

  cachedWatchlistDate = null;
  return { symbols: [], selectedDate: null };
}

export async function getMonitoredSubscriptionStocks(): Promise<MonitoredStock[]> {
  const { symbols: watchlistSymbols } = await loadWatchlistSymbols();
  
  const activeSuggestions = await db
    .select({ symbol: suggestionsTable.symbol })
    .from(suggestionsTable)
    .where(inArray(suggestionsTable.status, ["ACTIVE", "PENDING"]));
  const suggestionSymbols = activeSuggestions.map(s => s.symbol);

  const customWatchlist = await db
    .select({ symbol: customWatchlistTable.symbol })
    .from(customWatchlistTable);
  const customSymbols = customWatchlist.map(c => c.symbol);

  // Manual (client-requested) symbols first so the cap can never evict what the UI asked for.
  let ordered = [...new Set([...manualSymbols, ...customSymbols, ...watchlistSymbols, ...suggestionSymbols])];

  if (!ordered.length && isMarketOpen()) {
    const fallback = await getEffectiveUniverse(MONITORING_MAX_STOCKS);
    ordered = fallback.map((stock) => stock.symbol);
    if (ordered.length) {
      logger.warn(
        { count: ordered.length },
        "No watchlist for tick subscriptions; using fallback universe until scan completes",
      );
    }
  }

  if (ordered.length > FEED_MAX_STOCKS) {
    logger.warn(
      { total: ordered.length, cap: FEED_MAX_STOCKS, dropped: ordered.slice(FEED_MAX_STOCKS) },
      "Feed subscription cap exceeded; dropping symbols",
    );
    ordered = ordered.slice(0, FEED_MAX_STOCKS);
  }

  const resolved = await Promise.all(
    ordered.map(async (symbol) => {
      const stock = await findStockBySymbol(symbol);
      if (!stock) return null;
      let source: MonitoredStock["source"] = "watchlist";
      if (manualSymbols.has(stock.symbol)) {
        source = "manual";
      } else if (customSymbols.includes(stock.symbol)) {
        source = "manual"; // Treat custom watchlist as manual for monitoring purposes
      } else if (suggestionSymbols.includes(stock.symbol)) {
        source = "suggestion";
      }
      return { symbol: stock.symbol, key: stock.key, source };
    }),
  );

  return resolved.filter((s): s is MonitoredStock => Boolean(s));
}

export function getManualSymbols(): string[] {
  return [...manualSymbols];
}

export function getCachedWatchlistDate(): string | null {
  return cachedWatchlistDate;
}

export async function addManualMonitoredSymbol(symbol: string): Promise<MonitoredStock | null> {
  const stock = await findStockBySymbol(symbol.toUpperCase());
  if (!stock) return null;
  manualSymbols.add(stock.symbol);
  await addManualMonitoredSymbols([stock.symbol]);
  return { symbol: stock.symbol, key: stock.key, source: "manual" };
}

export async function isSymbolMonitored(symbol: string): Promise<boolean> {
  const stocks = await getMonitoredSubscriptionStocks();
  return stocks.some((s) => s.symbol === symbol.toUpperCase());
}

/** Push current monitored set to Upstox WS + tick feeder (watchlist + manual only). */
export async function syncMonitoredSubscriptions(): Promise<MonitoredStock[]> {
  const stocks = await getMonitoredSubscriptionStocks();
  const payload = stocks.map((s) => ({ symbol: s.symbol, key: s.key }));

  const INDICES_PAYLOAD = [
    { symbol: "NIFTY 50", key: "NSE_INDEX|Nifty 50" },
    { symbol: "BANKNIFTY", key: "NSE_INDEX|Nifty Bank" },
    { symbol: "FINNIFTY", key: "NSE_INDEX|Nifty Fin Service" },
    { symbol: "INDIA VIX", key: "NSE_INDEX|India VIX" },
    { symbol: "SENSEX", key: "BSE_INDEX|SENSEX" }
  ];

  const combinedPayload = [...INDICES_PAYLOAD, ...payload];

  logger.info(
    { count: combinedPayload.length, symbols: combinedPayload.map((s) => s.symbol).slice(0, 12) },
    "Syncing monitored-only market data subscriptions",
  );

  upstoxConnectionManager.updateSubscriptions(combinedPayload);
  if (combinedPayload.length > 0) {
    await initTickFeeder(combinedPayload);
  }

  // Dynamic queue sizing: allow ~3 ticks backlog per monitored symbol to prevent stale ticks
  const dynamicQueueSize = Math.max(50, payload.length * 3);
  import("../intelligence/worker_pool").then(({ intelligenceWorkerPools }) => {
    intelligenceWorkerPools.candidateDetection.setMaxQueueSize(dynamicQueueSize);
  }).catch(() => {});

  return stocks;
}

export async function removeManualMonitoredSymbol(symbol: string): Promise<boolean> {
  const norm = symbol.toUpperCase();
  if (manualSymbols.has(norm)) {
    manualSymbols.delete(norm);
    if (isMarketOpen()) {
      await syncMonitoredSubscriptions();
    }
    return true;
  }
  return false;
}

export function clearManualMonitoredSymbols(): void {
  manualSymbols.clear();
}
