import type { IntradayMonitoring } from "@/types/api";
import { SessionStateSchema, MarketRegimeSchema, SuggestionSchema } from "./schemas";
import { getBackendOrigin } from "./backendOrigin";
import { z } from "zod";

/**
 * A 4xx (other than 408/429) will not fix itself on retry: it means the request
 * is unauthorized, forbidden, malformed, or missing. Upstox endpoints answer
 * 401 until the user completes OAuth, and the dashboard polls them every 10-30s
 * — so a naive retry turns "not authorized yet" into a permanent request storm
 * that also retries the failure on every poll interval.
 *
 * React Query's `retry` is a function of (failureCount, error), so it can read
 * the HTTP status we attach here and bail out immediately on a permanent
 * failure while still retrying genuine transients.
 */
export class ApiHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
  }
}

/** True when the status will never succeed on a retry. */
export function isPermanentFailure(error: unknown): boolean {
  if (error instanceof ApiHttpError) {
    return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
  }
  return false;
}

/**
 * A `refetchInterval` that stops polling once the query has failed permanently.
 *
 * React Query keeps honouring `refetchInterval` after the last attempt errored,
 * so an unauthenticated 401 still produced a request every 10-30s, forever. Once
 * the user completes OAuth the queries are invalidated and restart, so nothing
 * is lost by standing down in the meantime.
 *
 * Use in place of a raw number: refetchInterval: stopPollingWhenBroken(30000)
 */
export function stopPollingWhenBroken(intervalMs: number) {
  return (query: { state: { error: unknown } }): number | false =>
    isPermanentFailure(query.state.error) ? false : intervalMs;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("mimir_admin_token");
  const headers = new Headers(init?.headers);

  // Only send Content-Type when there is actually a body.
  //
  // Setting `Content-Type: application/json` on a bodyless GET makes it a
  // non-simple CORS request, so the browser must send an OPTIONS preflight
  // before EVERY call - doubling request count and round-trips. That was 223
  // preflights for 244 real requests. `application/json` is also the wrong
  // Content-Type for a request with no body.
  const hasBody = init?.body != null && init.body !== "";
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  // x-admin-token is likewise a custom header that forces a preflight, so send
  // it only when one is actually configured.
  if (token) {
    headers.set("x-admin-token", token);
  }

  const baseUrl = getBackendOrigin();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      credentials: "include",
      ...init,
      headers,
    });
  } catch (err) {
    // TypeError: Failed to fetch — network down / backend not running
    throw new Error("Can't reach server — check connection", { cause: err });
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    if (res.ok && res.status !== 204) {
      throw new Error("Server returned an invalid response", { cause: err });
    }
  }

  if (!res.ok) {
    if (res.status === 503 && body && typeof body === "object" && "fallback" in body) {
      return (body as { fallback: T }).fallback;
    }
    const typedBody = body as { error?: string; message?: string } | null;
    // Carry the status so the query layer can distinguish a permanent 4xx from
    // a transient 5xx and stop retrying the former.
    if (typedBody?.error || typedBody?.message) {
      throw new ApiHttpError(res.status, typedBody.error || typedBody.message!);
    }
    // No structured error from server — keep it human, log the raw text for debugging
    console.error(`API ${res.status} ${path}:`, text.slice(0, 200));
    throw new ApiHttpError(
      res.status,
      res.status >= 500 ? "Server error — retrying shortly" : `Request failed (${res.status})`,
    );
  }

  return body as T;
}

async function apiFetchSoft<T>(path: string, fallback: T): Promise<T> {
  try {
    const token = localStorage.getItem("mimir_admin_token");
    const headers = new Headers();
    if (token) headers.set("x-admin-token", token);

    const baseUrl = getBackendOrigin();
    const res = await fetch(`${baseUrl}${path}`, { credentials: "include", headers });

    if (!res.ok) {
      // Log each distinct failure once. These are polled every 10-30s, so an
      // unconditional console.error per poll buried the console in the same
      // "Upstox authentication required" line forever and made real errors
      // invisible.
      logFetchFailureOnce(`${res.status} ${path}`);
      return { ...fallback, available: false } as T;
    }

    const body = await res.json().catch(() => null);
    if (!body) {
      logFetchFailureOnce(`unparseable ${path}`);
      return { ...fallback, available: false } as T;
    }
    return body as T;
  } catch (err) {
    logFetchFailureOnce(`${path} ${String(err)}`);
    return fallback;
  }
}

/** Deduplicated soft-fetch logging: one line per unique failure, not per poll. */
const softFailureKeys = new Set<string>();
function logFetchFailureOnce(key: string): void {
  if (softFailureKeys.has(key)) return;
  // Bound the set so a long session with many distinct failures cannot grow it
  // without limit.
  if (softFailureKeys.size > 50) softFailureKeys.clear();
  softFailureKeys.add(key);
  console.warn(`[api] soft fetch unavailable (${key}) — further occurrences of this failure are suppressed`);
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
  customWatchlist: () => apiFetch<{ data: { symbol: string, createdAt: string }[] }>("/api/watchlist/custom"),
  addCustomWatchlist: (symbol: string) => apiFetch<{ success: boolean, symbol: string }>("/api/watchlist/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol })
  }),
  removeCustomWatchlist: (symbol: string) => apiFetch<{ success: boolean }>(`/api/watchlist/custom/${symbol}`, {
    method: "DELETE"
  }),
  activeSuggestions: (symbol?: string) => 
    apiFetch<import("@/types/api").Suggestion[]>(`/api/suggestions/active${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`)
      .then(res => z.array(SuggestionSchema).parse(res)),
  todaySuggestions: () => apiFetch<import("@/types/api").Suggestion[]>("/api/suggestions/today")
    .then(res => z.array(SuggestionSchema).parse(res)),
  historySuggestions: () => apiFetch<{ data: import("@/types/api").Suggestion[], total: number }>("/api/suggestions/history?limit=100")
    .then(res => ({ ...res, data: z.array(SuggestionSchema).parse(res.data) })),
  suggestionsAccuracy: () =>
    apiFetch<{
      closedTrades: number;
      winRate: number | null;
      totalPnlInr: number;
      lookbackDays: number;
      setups: Array<{ setupType: string; tradeType: string; samples: number; winRate: number; avgPnlInr: number; medianTimeToTargetMin: number | null }>;
    }>("/api/suggestions/accuracy"),
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
  headlessAuth: {
    begin: (type: "trading" | "data") =>
      apiFetch<{ status: string }>("/api/system/headless/begin", { method: "POST", body: JSON.stringify({ type }) }),
    startPhone: (type: "trading" | "data", phone: string) =>
      apiFetch<{ status: string }>("/api/system/headless/phone", { method: "POST", body: JSON.stringify({ type, phone }) }),
    submitOtp: (otp: string) =>
      apiFetch<{ status: string }>("/api/system/headless/otp", { method: "POST", body: JSON.stringify({ otp }) }),
    submitPin: (pin: string) =>
      apiFetch<{ status: string }>("/api/system/headless/pin", { method: "POST", body: JSON.stringify({ pin }) }),
    cancel: () =>
      apiFetch<{ status: string }>("/api/system/headless/cancel", { method: "POST", body: JSON.stringify({}) }),
  },
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
      return Promise.reject(new Error("No symbol selected"));
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
  reportByDate: (date: string) => apiFetch<{ id: string; date: string; summary: string; content: string; createdAt: string }>(`/api/reports/by-date/${encodeURIComponent(date)}`),
  generateReport: (date?: string) => apiFetch<{ success: boolean; message: string }>("/api/reports/generate", { method: "POST", body: JSON.stringify({ date }) }),
  getConfig: () => apiFetch<import("@/types/api").SystemConfig>("/api/config"),
  updateConfig: (body: import("@/types/api").UpdateSystemConfig) =>
    apiFetch<import("@/types/api").SystemConfig>("/api/config", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  screener: {
    list: () => apiFetch<Array<Record<string, unknown>>>("/api/screener"),
    create: (body: unknown) => apiFetch<Record<string, unknown>>("/api/screener", { method: "POST", body: JSON.stringify(body) }),
    update: (id: number, body: unknown) => apiFetch<Record<string, unknown>>(`/api/screener/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    delete: (id: number) => apiFetch<{ success: boolean }>(`/api/screener/${id}`, { method: "DELETE" }),
    targets: () => apiFetch<Array<Record<string, unknown>>>("/api/screener/targets"),
    addTarget: (body: unknown) => apiFetch<Record<string, unknown>>("/api/screener/targets", { method: "POST", body: JSON.stringify(body) }),
    deleteTarget: (id: number) => apiFetch<{ success: boolean }>(`/api/screener/targets/${id}`, { method: "DELETE" }),
    matches: () => apiFetch<Array<Record<string, unknown>>>("/api/screener/matches"),
    run: (screenerId?: number) => apiFetch<{ success: boolean; message: string }>("/api/screener/run", { method: "POST", body: JSON.stringify(screenerId ? { screenerId } : {}) }),
  },
};
