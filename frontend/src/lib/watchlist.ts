import type { MonitoredStock, WatchlistItem } from "@/types/api";
import { marketDataStore } from "@/providers/MarketDataProvider";

export interface StockRow {
  symbol: string;
  name: string;
  category: string;
  condition: string;
  price: number | null;
  changePct: number | null;
  indicatorStatus: string;
  suggestion: string;
  signalGenerated?: boolean;
  compositeScore?: number;
  components?: Record<string, number>;
  signalTags?: string[];
  activeSignalDirection?: "BUY" | "SELL" | null;
  sparkline?: number[];
}

export function buildStockRows(
  items: WatchlistItem[],
  customItems: { symbol: string, createdAt: string }[],
  monitored: MonitoredStock[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _suggestions: any[],
  ticks: Record<string, { price: number }>,
  sparklines?: Record<string, number[]>,
): StockRow[] {
  const monitoredMap = new Map(monitored.map((m) => [m.symbol, m]));
  const activeSuggestionsMap = new Map<string, "BUY" | "SELL">(
    Array.isArray(_suggestions)
      ? _suggestions
          .filter((s) => s && (s.status === "ACTIVE" || s.status === "PENDING") && s.symbol)
          .map((s) => [s.symbol, s.direction === "SELL" ? "SELL" : "BUY"])
      : []
  );

  const rows = items.map((item) => {
    const mon = monitoredMap.get(item.symbol);
    const tick = ticks[item.symbol];
    const liveData = marketDataStore.get(item.symbol);
    
    const sparkline = sparklines?.[item.symbol];
    const len = sparkline?.length ?? 0;
    const fallbackPrice = len > 0 ? sparkline?.[len - 1] : null;
    const fallbackPrevClose = len > 1 ? sparkline?.[len - 2] : null;

    const price = tick?.price ?? liveData?.ltp ?? mon?.currentPrice ?? item.ltp ?? fallbackPrice ?? null;
    
    let changePct = liveData?.changePct ?? item.changePct ?? item.changePct ?? null;
    if (changePct == null && price != null) {
      if (item.prevClose != null && item.prevClose > 0) {
        changePct = ((price - item.prevClose) / item.prevClose) * 100;
      } else if (fallbackPrevClose != null && fallbackPrevClose > 0) {
        changePct = ((price - fallbackPrevClose) / fallbackPrevClose) * 100;
      }
    }

    let activeSignalDirection: "BUY" | "SELL" | null = null;
    const activeDir = activeSuggestionsMap.get(item.symbol);
    if (activeDir) {
      activeSignalDirection = activeDir;
    }

    return {
      symbol: item.symbol,
      name: item.name,
      category: item.category,
      condition: item.condition,
      price,
      changePct,
      indicatorStatus: item.indicatorStatus || item.condition || item.category.replaceAll("_", " "),
      suggestion: item.suggestionLabel || "HOLD",
      signalGenerated: item.signalGenerated || mon?.signalGenerated,
      compositeScore: item.compositeScore,
      components: item.components,
      signalTags: item.signalTags,
      activeSignalDirection,
      sparkline,
    };
  });

  // Sort rows so that active signals and monitored items appear at the top,
  // then sort by composite score descending.
  rows.sort((a, b) => {
    const aSignal = a.activeSignalDirection != null || a.category === "ACTIVE SIGNALS";
    const bSignal = b.activeSignalDirection != null || b.category === "ACTIVE SIGNALS";
    if (aSignal && !bSignal) return -1;
    if (!aSignal && bSignal) return 1;

    const aMonitored = monitoredMap.has(a.symbol) || (a.condition && a.condition.includes("Monitored"));
    const bMonitored = monitoredMap.has(b.symbol) || (b.condition && b.condition.includes("Monitored"));
    if (aMonitored && !bMonitored) return -1;
    if (!aMonitored && bMonitored) return 1;
    
    // Both are signal or both are not signal, sort by score
    const scoreA = a.compositeScore || 0;
    const scoreB = b.compositeScore || 0;
    return scoreB - scoreA;
  });

  const existingSymbols = new Set(rows.map(r => r.symbol));

  const customRows = customItems.filter(c => !existingSymbols.has(c.symbol)).map(item => {
    const mon = monitoredMap.get(item.symbol);
    const tick = ticks[item.symbol];
    const liveData = marketDataStore.get(item.symbol);
    
    const sparkline = sparklines?.[item.symbol];
    const fallbackPrice = sparkline && sparkline.length > 0 ? sparkline[sparkline.length - 1] : null;

    const fallbackPrevClose = sparkline && sparkline.length > 1 ? sparkline[sparkline.length - 2] : null;

    const price = tick?.price ?? liveData?.ltp ?? mon?.currentPrice ?? fallbackPrice ?? null;
    let changePct = liveData?.changePct ?? null;
    
    if (changePct === null && price !== null) {
      const prev = fallbackPrevClose;
      if (prev != null && prev !== 0) changePct = ((price - prev) / prev) * 100;
    }

    return {
      symbol: item.symbol,
      name: item.symbol, // We could fetch proper name, but symbol works for now
      category: "CUSTOM",
      condition: "Manual Watchlist",
      price,
      changePct,
      indicatorStatus: "Monitored",
      suggestion: "WATCH",
      sparkline,
    };
  });

  return [...rows, ...customRows];
}

