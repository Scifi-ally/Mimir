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

  void queryClient
    .ensureQueryData({
      queryKey: ["symbol-insights", trimmed],
      queryFn: () => api.symbolInsights(trimmed),
      staleTime: 60000,
    })
    .catch(() => {});

  void queryClient
    .ensureQueryData({
      queryKey: ["candles", trimmed, "day", 15],
      queryFn: () => api.candles(trimmed, "day", 15),
      staleTime: 5 * 60 * 1000,
    })
    .catch(() => {});
}
