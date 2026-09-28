import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * Warm the caches a symbol's detail view needs, before the user commits to it.
 * Called on hover/pointer-enter of a watchlist or screener row: by the time
 * the click lands (~150-400ms later) the network round-trip is usually already
 * done, so the panel renders from cache instead of flashing a skeleton.
 *
 * ensureQueryData is a no-op when fresh data is already cached, so repeated
 * hovers are cheap. Errors are swallowed — this is best-effort warming.
 */
export function prefetchSymbol(queryClient: QueryClient, symbol: string) {
  const trimmed = symbol?.trim();
  if (!trimmed) return;

  // Hover-prefetch fired on every pointer-enter, so moving down a watchlist list
  // queued a request per row. Coalesce per symbol within a short window: only the
  // most recent hover for a given symbol actually needs warming, and the cache
  // absorbs the rest.
  schedulePrefetch(queryClient, trimmed);
}

const prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PREFETCH_DEBOUNCE_MS = 120;

function schedulePrefetch(queryClient: QueryClient, symbol: string) {
  const existing = prefetchTimers.get(symbol);
  if (existing) clearTimeout(existing);

  prefetchTimers.set(symbol, setTimeout(() => {
    prefetchTimers.delete(symbol);
    void queryClient
      .ensureQueryData({
        queryKey: ["symbol-insights", symbol],
        queryFn: () => api.symbolInsights(symbol),
        staleTime: 60000,
      })
      .catch(() => {});

    void queryClient
      .ensureQueryData({
        queryKey: ["candles", symbol, "day", 15],
        queryFn: () => api.candles(symbol, "day", 15),
        staleTime: 5 * 60 * 1000,
      })
      .catch(() => {});
  }, PREFETCH_DEBOUNCE_MS));
}
