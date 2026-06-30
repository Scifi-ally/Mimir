import type { IntradayMonitoring } from "@/types/api";
import { SessionStateSchema, MarketRegimeSchema, SuggestionSchema } from "./schemas";
import { z } from "zod";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    if (res.ok && res.status !== 204) {
      throw new Error(`Invalid JSON response: ${text.slice(0, 100)}...`, { cause: err });
    }
  }

  if (!res.ok) {
    if (res.status === 503 && body && "fallback" in body) {
      return body.fallback as T;
    }
    const errMsg = body?.error || body?.message || text.slice(0, 50) || `Request failed (${res.status})`;
    throw new Error(errMsg);
  }

  return body as T;
}

async function apiFetchSoft<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(path, { credentials: "include" });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ...fallback, ...(body ?? {}), available: false } as T;
    return body as T;
  } catch (err) {
    console.warn(`Soft API fetch failed for ${path}:`, err);
    return fallback;
  }
}

export function normalizeMonitoringPayload(
  payload: Partial<IntradayMonitoring> & { maxLimit?: number },
): IntradayMonitoring {
  const monitoredStocks = payload.monitoredStocks ?? [];
  const monitoringMaxStocks =
    payload.monitoringMaxStocks ?? payload.maxLimit ?? monitoredStocks.length;

  return {
    active: payload.active ?? false,
    monitoredStocks,
    monitoredStocksCount:
      payload.monitoredStocksCount ?? monitoredStocks.length,
    lastMonitoringCycle: payload.lastMonitoringCycle ?? null,
    monitoringMaxStocks,
  };
}

export const api = {
  sessionState: () => apiFetch<import("@/types/api").SessionState>("/api/system/session-state").then(res => SessionStateSchema.parse(res)),
  systemStatus: () => apiFetch<import("@/types/api").SystemStatus>("/api/system/status"),
  watchlistToday: () => apiFetch<import("@/types/api").Watchlist>("/api/watchlist/today"),
  activeSuggestions: (symbol?: string) => 
    apiFetch<import("@/types/api").Suggestion[]>(`/api/suggestions/active${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`)
      .then(res => z.array(SuggestionSchema as any).parse(res) as import("@/types/api").Suggestion[]),
  todaySuggestions: () => apiFetch<import("@/types/api").Suggestion[]>("/api/suggestions/today")
    .then(res => z.array(SuggestionSchema as any).parse(res) as import("@/types/api").Suggestion[]),
  dashboardIndices: () =>
    apiFetch<import("@/types/api").DashboardIndices & { degraded?: boolean; reason?: string }>(
      "/api/market/dashboard-indices",
    ),
  marketRegime: () => apiFetch<import("@/types/api").MarketRegime>("/api/market/regime").then(res => MarketRegimeSchema.parse(res)),
  marketMacro: () => apiFetch<any>("/api/market/macro"),
  intradayMonitoring: () =>
    apiFetch<IntradayMonitoring>("/api/system/intraday-monitoring").then(normalizeMonitoringPayload),
  scanStatus: () => apiFetch<import("@/types/api").ScanStatus>("/api/system/offhours-scan"),
  monitoredSymbols: () =>
    apiFetch<{
      symbols: string[];
      watchlistDate: string | null;
      scanRunning: boolean;
      scanMode: string;
      maxStocks: number;
    }>("/api/system/monitored-symbols"),
  candles: (symbol: string, interval: string, lookbackDays: number, endDate?: string) =>
    apiFetch<{ candles: import("@/types/api").Candle[] }>(
      `/api/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&lookbackDays=${lookbackDays}${endDate ? `&endDate=${encodeURIComponent(endDate)}` : ""}`,
    ),
  authUrl: () => apiFetch<{ url: string; alreadyAuthenticated?: boolean; error?: string }>("/api/system/auth-url"),
  triggerScan: () =>
    apiFetch<{ started: boolean; mode?: string; error?: string; alreadyRunning?: boolean }>(
      "/api/system/offhours-scan",
      { method: "POST", body: JSON.stringify({ force: true }) },
    ),
  stopScan: () =>
    apiFetch<{ message: string; status: any }>("/api/system/offhours-scan/stop", {
      method: "POST",
    }),
  runFullScan: () =>
    apiFetch<{ started: boolean; mode?: string; error?: string; alreadyRunning?: boolean }>(
      "/api/system/post-market-scanner",
      { method: "POST", body: JSON.stringify({}) },
    ),
  forecast: (symbol: string) => {
    const trimmed = symbol.trim();
    if (!trimmed) {
      return Promise.resolve({ symbol: "", available: false, error: "No symbol selected" });
    }
    return apiFetchSoft<import("@/types/api").SymbolForecast>(
      `/api/market/forecast?symbol=${encodeURIComponent(trimmed)}`,
      { symbol: trimmed, available: false, error: "Forecast unavailable" },
    );
  },
  symbolInsights: (symbol: string) => {
    const trimmed = symbol.trim();
    if (!trimmed) {
      return Promise.reject(new Error("No symbol selected"));
    }
    return apiFetchSoft<import("@/types/api").SymbolInsights>(
      `/api/market/symbol-insights?symbol=${encodeURIComponent(trimmed)}`,
      {
        symbol: trimmed,
        name: trimmed,
        sector: "",
        scan: null,
        indicators: null,
        monitoring: null,
        ai: null,
        fetchedAt: new Date().toISOString(),
      },
    );
  },
  searchSymbols: (query: string, limit = 12) =>
    apiFetch<{ items: import("@/types/api").SymbolSearchResult[] }>(
      `/api/system/symbols?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
  paperTrading: {
    account: () => apiFetch<any>("/api/paper/account"),
    positions: () => apiFetch<any[]>("/api/paper/positions"),
    history: () => apiFetch<any[]>("/api/paper/history"),
    reset: () => apiFetch<any>("/api/paper/reset", { method: "POST" }),
  },
  sparklines: (symbols: string[]) => {
    if (!symbols.length) return Promise.resolve({});
    return apiFetchSoft<Record<string, number[]>>(
      `/api/market/sparklines?symbols=${encodeURIComponent(symbols.join(","))}`,
      {}
    );
  },
  scoreHistory: (symbol: string) => {
    if (!symbol) return Promise.resolve({ symbol: "", history: [] });
    return apiFetchSoft<{ symbol: string, history: number[] }>(
      `/api/market/score-history/${encodeURIComponent(symbol)}`,
      { symbol, history: [] }
    );
  },
  indianContext: () => apiFetchSoft<any>("/api/market/indian-context", {
    fiiDii: null,
    niftyOptionChain: null,
    usdInr: null,
    india10y: null,
    macroScore: 0,
    eventRiskActive: false
  }),
  get paper() { return this.paperTrading; },
  alertsHistory: () => apiFetch<unknown[]>("/api/alerts/history"),
};
