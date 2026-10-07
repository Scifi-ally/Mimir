import type { OHLCV } from "./types";

const indices = new WeakMap<OHLCV[], Map<string, number>>();
function session(ts: string): string {
  return new Date(Date.parse(ts) + 5.5 * 3600_000).toISOString().slice(0, 10);
}
function historyIndex(candles: OHLCV[]): Map<string, number> {
  const cached = indices.get(candles);
  if (cached) return cached;
  const index = new Map<string, number>();
  for (const candle of candles) {
    if (!Number.isFinite(Date.parse(candle.timestamp))) continue;
    const date = session(candle.timestamp);
    // Retain ambiguity, never overwrite a conflicting session with the last
    // source row. NaN makes either benchmark endpoint unavailable.
    index.set(date, index.has(date) ? NaN : candle.close);
  }
  indices.set(candles, index);
  return index;
}

/** Match actual sessions, not array positions from independently fetched series.
 * Returns null when the benchmark was not observed on both stock endpoints. */
export function relativeStrength60(stock: OHLCV[], benchmark: OHLCV[]): number | null {
  if (stock.length < 61) return null;
  const first = stock[stock.length - 61]!, last = stock[stock.length - 1]!;
  const byDate = historyIndex(benchmark);
  const old = byDate.get(session(first.timestamp)), now = byDate.get(session(last.timestamp));
  if (![first.close, last.close, old, now].every(v => typeof v === "number" && Number.isFinite(v) && v > 0)) return null;
  return (last.close / first.close) / (now! / old!);
}

/** Equal-weight peer benchmark, excluding the subject. Caller supplies the full
 * observed universe, never only stocks that passed a setup detector. */
export function sectorRelativeStrength60(
  symbol: string, sector: string, stock: OHLCV[],
  histories: Map<string, OHLCV[]>, sectors: Map<string, string>,
): number | null {
  if (sector === "Other" || sector === "INDEX" || stock.length < 61) return null;
  const first = stock[stock.length - 61]!, last = stock[stock.length - 1]!;
  const start = session(first.timestamp), end = session(last.timestamp);
  const ratios: number[] = [];
  for (const [peer, candles] of histories) {
    if (peer === symbol || sectors.get(peer) !== sector) continue;
    const index = historyIndex(candles);
    const old = index.get(start), now = index.get(end);
    if (old && now && Number.isFinite(old) && Number.isFinite(now) && old > 0 && now > 0) ratios.push(now / old);
  }
  if (ratios.length < 2 || first.close <= 0 || last.close <= 0) return null;
  const benchmarkReturn = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return (last.close / first.close) / benchmarkReturn;
}
