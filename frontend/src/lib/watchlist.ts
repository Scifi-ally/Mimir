import type { MonitoredStock, WatchlistItem } from "@/types/api";

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
}

export function buildStockRows(
  items: WatchlistItem[],
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
          .filter((s) => s && s.status === "ACTIVE" && s.symbol)
          .map((s) => [s.symbol, s.direction === "SELL" ? "SELL" : "BUY"])
      : []
  );

  const rows = items.map((item) => {
    const mon = monitoredMap.get(item.symbol);
    const tick = ticks[item.symbol];
    
    const sparkline = sparklines?.[item.symbol];
    const fallbackPrice = sparkline && sparkline.length > 0 ? sparkline[sparkline.length - 1] : null;
    const fallbackFirstPrice = sparkline && sparkline.length > 0 ? sparkline[0] : null;

    const price = tick?.price ?? mon?.currentPrice ?? item.ltp ?? fallbackPrice ?? null;
    const refPrice = item.prevClose ?? mon?.entryPrice ?? null;
    
    let changePct = null;
    if (price != null && refPrice != null && refPrice > 0) {
      changePct = ((price - refPrice) / refPrice) * 100;
    } else if (price != null && fallbackFirstPrice != null && fallbackFirstPrice > 0) {
      changePct = ((price - fallbackFirstPrice) / fallbackFirstPrice) * 100;
    }

    let activeSignalDirection: "BUY" | "SELL" | null = null;
    const activeDir = activeSuggestionsMap.get(item.symbol);
    if (activeDir) {
      activeSignalDirection = activeDir;
    } else if (item.suggestionLabel === "BUY" || item.suggestionLabel === "SELL") {
      activeSignalDirection = item.suggestionLabel;
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
    };
  });

  // Sort rows so that active signals and watches appear at the top,
  // then sort by composite score descending.
  rows.sort((a, b) => {
    const aSignal = a.suggestion !== "HOLD";
    const bSignal = b.suggestion !== "HOLD";
    if (aSignal && !bSignal) return -1;
    if (!aSignal && bSignal) return 1;
    
    // Both are signal or both are not signal, sort by score
    const scoreA = a.compositeScore || 0;
    const scoreB = b.compositeScore || 0;
    return scoreB - scoreA;
  });

  return rows;
}

