import type { IntradayMonitoring } from "@/types/api";
import { SessionStateSchema, MarketRegimeSchema, SuggestionSchema } from "./schemas";
import { z } from "zod";

export function hasAdminToken(): boolean {
  return Boolean(localStorage.getItem("mimir_admin_token")?.trim());
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("mimir_admin_token");
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("x-admin-token", token);
  }

  const baseUrl = import.meta.env.VITE_API_URL || "";
  const res = await fetch(`${baseUrl}${path}`, {
    credentials: "include",
    ...init,
    headers,
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    if (res.ok && res.status !== 204) {
      throw new Error(`Invalid JSON response: ${text.slice(0, 100)}...`, { cause: err });
    }
  }

  if (!res.ok) {
    if (res.status === 503 && body && typeof body === "object" && "fallback" in body) {
      return body.fallback as T;
    }
    const typedBody = body as { error?: string; message?: string };
    if (typedBody?.error || typedBody?.message) {
      throw new Error(typedBody.error || typedBody.message || `API Error: ${res.status}`);
    }
    throw new Error(text.slice(0, 50) || `Request failed (${res.status})`);
  }

  return body as T;
}

async function apiFetchSoft<T>(path: string, fallback: T): Promise<T> {
  try {
    const token = localStorage.getItem("mimir_admin_token");
    const headers = new Headers();
    if (token) headers.set("x-admin-token", token);

    const baseUrl = import.meta.env.VITE_API_URL || "";
    const res = await fetch(`${baseUrl}${path}`, { credentials: "include", headers });
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
      .then(res => z.array(SuggestionSchema as z.ZodTypeAny).parse(res) as import("@/types/api").Suggestion[]),
  todaySuggestions: () => apiFetch<import("@/types/api").Suggestion[]>("/api/suggestions/today")
    .then(res => z.array(SuggestionSchema as z.ZodTypeAny).parse(res) as import("@/types/api").Suggestion[]),
  historySuggestions: () => apiFetch<{ data: import("@/types/api").Suggestion[], total: number }>("/api/suggestions/history?limit=100")
    .then(res => ({ ...res, data: z.array(SuggestionSchema as z.ZodTypeAny).parse(res.data) as import("@/types/api").Suggestion[] })),
  dashboardIndices: () =>
    apiFetch<import("@/types/api").DashboardIndices & { degraded?: boolean; reason?: string }>(
      "/api/market/dashboard-indices",
    ),
  fetchOFI: (symbol: string) => apiFetch<{ buyVolume: number; sellVolume: number; ofi: number; ofiRatio: number; ticksEvaluated: number }>(`/api/market/ofi?symbol=${encodeURIComponent(symbol)}`),
  marketRegime: () => apiFetch<import("@/types/api").MarketRegime>("/api/market/regime").then(res => MarketRegimeSchema.parse(res)),
  marketMacro: () => apiFetch<unknown>("/api/market/macro"),
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
  authUrl: (type?: "trading" | "data") => apiFetch<{ url: string; alreadyAuthenticated?: boolean; error?: string }>(`/api/system/auth-url${type ? `?type=${type}` : ""}`),
  triggerScan: () =>
    apiFetch<{ started: boolean; mode?: string; error?: string; alreadyRunning?: boolean }>(
      "/api/system/offhours-scan",
      { method: "POST", body: JSON.stringify({ force: true }) },
    ),
  stopScan: () =>
    apiFetch<{ message: string; status: unknown }>("/api/system/offhours-scan/stop", {
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
    account: () => apiFetch<import("@/types/api").PaperAccount>("/api/paper/account"),
    positions: () => apiFetch<import("@/types/api").PaperPosition[]>("/api/paper/positions"),
    history: () => apiFetch<import("@/types/api").PaperPosition[]>("/api/paper/history"),
    reset: () => apiFetch<{ success: boolean; message: string }>("/api/paper/reset", { method: "POST" }),
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
  // Fallback must be honest: null fields render as "N/A", never fabricated numbers.
  indianContext: () => apiFetchSoft<unknown>("/api/market/indian-context", {
    fiiDii: null,
    niftyOptionChain: null,
    usdInr: null,
    india10y: null,
    macroScore: null,
    eventRiskActive: false
  }),
  get paper() { return this.paperTrading; },
  tradingMode: () =>
    apiFetch<{ mode: "PAPER" | "LIVE"; liveActive: boolean; brokerAuthenticated: boolean; armPhrase: string }>(
      "/api/trading/mode",
    ),
  setTradingMode: (mode: "PAPER" | "LIVE", confirmationPhrase?: string) =>
    apiFetch<{ mode: "PAPER" | "LIVE"; liveActive: boolean; availableMargin?: number }>("/api/trading/mode", {
      method: "POST",
      body: JSON.stringify({ mode, confirmationPhrase }),
    }),
  liveBrokerPositions: () =>
    apiFetch<Array<{ symbol: string; quantity: number; avgPrice: number; lastPrice: number; pnl: number; product: string }>>(
      "/api/trading/live/positions",
    ),
  liveBrokerFunds: () =>
    apiFetch<{ availableMargin: number; usedMargin: number }>("/api/trading/live/funds"),
  liveOrders: (limit = 50) =>
    apiFetch<Array<{ id: string; symbol: string; direction: string; orderType: string; quantity: number; price: string | null; status: string; statusMessage: string | null; brokerOrderId: string | null; placedAt: string }>>(
      `/api/trading/live/orders?limit=${limit}`,
    ),
  alertsHistory: () => apiFetch<import("@/types/api").AlertRecord[]>("/api/alerts/history"),
  reports: () => apiFetch<Array<{ id: string; date: string; summary: string; content: string; createdAt: string }>>("/api/reports"),
  getConfig: (reveal = true) => apiFetch<import("@/types/api").SystemConfig>(reveal ? "/api/config?reveal=true" : "/api/config"),
  updateConfig: (body: import("@/types/api").UpdateSystemConfig) =>
    apiFetch<import("@/types/api").SystemConfig>("/api/config", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};
