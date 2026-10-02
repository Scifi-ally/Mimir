export type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
export type Series = { key: string; candles: Candle[] };
export type Trade = { signalDate: string; entryDate: string; exitDate: string; netPct: number; outcome: "WIN" | "LOSS" | "TIMEOUT" | "NO_FILL" };

export function passesGapGuard(signalClose: number, nextOpen: number): boolean {
  return nextOpen <= signalClose * 1.015;
}

export function simulateLong(
  candles: Candle[],
  signalIndex: number,
  stop: number | null,
  target: number | null,
  holdBars: number,
  costPerSide: number,
): Trade | null {
  const entryIndex = signalIndex + 1;
  const entryBar = candles[entryIndex];
  if (!entryBar || !(entryBar.open > 0)) return null;
  const entry = entryBar.open;
  const lastIndex = Math.min(signalIndex + holdBars, candles.length - 1);
  const net = (exit: number) => (exit / entry - 1 - 2 * costPerSide) * 100;
  for (let index = entryIndex; index <= lastIndex; index++) {
    const bar = candles[index]!;
    if (stop != null && bar.open <= stop) {
      return { signalDate: candles[signalIndex]!.date, entryDate: entryBar.date, exitDate: bar.date, netPct: net(bar.open), outcome: "LOSS" };
    }
    if (stop != null && bar.low <= stop) {
      return { signalDate: candles[signalIndex]!.date, entryDate: entryBar.date, exitDate: bar.date, netPct: net(stop), outcome: "LOSS" };
    }
    if (target != null && bar.high >= target) {
      const exit = index === entryIndex && bar.open > target ? bar.open : target;
      return { signalDate: candles[signalIndex]!.date, entryDate: entryBar.date, exitDate: bar.date, netPct: net(exit), outcome: "WIN" };
    }
  }
  const exit = candles[lastIndex]!;
  const result = net(exit.close);
  return { signalDate: candles[signalIndex]!.date, entryDate: entryBar.date, exitDate: exit.date, netPct: result, outcome: "TIMEOUT" };
}

export function matchedWindowAlpha(
  trade: Pick<Trade, "entryDate" | "exitDate" | "netPct">,
  benchmark: Map<string, number>,
): number | null {
  const entryLevel = benchmark.get(trade.entryDate);
  const exitLevel = benchmark.get(trade.exitDate);
  return entryLevel != null && exitLevel != null && entryLevel > 0
    ? trade.netPct - (exitLevel / entryLevel - 1) * 100
    : null;
}

export function equalWeightIndex(series: Series[]): Map<string, number> {
  const dates = [...new Set(series.flatMap((item) => item.candles.map((candle) => candle.date)))].sort();
  const returns = new Map<string, number[]>();
  for (const item of series) {
    for (let index = 1; index < item.candles.length; index++) {
      const previous = item.candles[index - 1]!.close;
      const current = item.candles[index]!.close;
      if (previous > 0) (returns.get(item.candles[index]!.date) ?? returns.set(item.candles[index]!.date, []).get(item.candles[index]!.date)!).push(current / previous - 1);
    }
  }
  const index = new Map<string, number>();
  let level = 1;
  for (const date of dates) {
    const daily = returns.get(date);
    if (daily?.length) level *= 1 + daily.reduce((sum, value) => sum + value, 0) / daily.length;
    index.set(date, level);
  }
  return index;
}

export function ema(values: number[], period: number): number[] {
  const out = values.map((value) => value);
  const k = 2 / (period + 1);
  for (let index = period; index < values.length; index++) out[index] = values[index]! * k + out[index - 1]! * (1 - k);
  return out;
}

export function regimeDates(benchmark: Map<string, number>): Set<string> {
  const dates = [...benchmark.keys()].sort();
  const levels = dates.map((date) => benchmark.get(date)!);
  const benchmarkEma = ema(levels, 50);
  return new Set(dates.filter((date, index) => index >= 50 && levels[index]! > benchmarkEma[index]!));
}

export function atr(candles: Candle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(0);
  for (let index = 1; index < candles.length; index++) {
    const tr = Math.max(candles[index]!.high - candles[index]!.low, Math.abs(candles[index]!.high - candles[index - 1]!.close), Math.abs(candles[index]!.low - candles[index - 1]!.close));
    out[index] = index <= period ? (out[index - 1]! * (index - 1) + tr) / index : (out[index - 1]! * (period - 1) + tr) / period;
  }
  return out;
}

function rsi2(candles: Candle[]): number[] {
  return candles.map((_, index) => {
    if (index < 2) return NaN;
    const changes = [candles[index]!.close - candles[index - 1]!.close, candles[index - 1]!.close - candles[index - 2]!.close];
    const gain = changes.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const loss = changes.filter((value) => value < 0).reduce((sum, value) => sum - value, 0);
    return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  });
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  if (!ordered.length) return NaN;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export function pullback(series: Series, costPerSide: number, regime?: Set<string>): Trade[] {
  const candles = series.candles, close = candles.map((candle) => candle.close);
  const ema20 = ema(close, 20), ema50 = ema(close, 50), atr14 = atr(candles);
  const volSma20 = candles.map((_, index) => {
    const values = candles.slice(Math.max(0, index - 19), index + 1).map((candle) => candle.volume);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  });
  const trades: Trade[] = [];
  let lastSignal = -Infinity;
  for (let index = 55; index < candles.length - 1; index++) {
    if (index - lastSignal < 15) continue;
    const current = candles[index]!, currentAtr = atr14[index]!;
    if (regime && !regime.has(current.date)) continue;
    if (current.close < 20 || current.close * volSma20[index]! < 10_000_000) continue;
    if (!(ema20[index]! > ema50[index]! && current.close > ema50[index]! && ema50[index]! > ema50[index - 10]!)) continue;
    const high40 = Math.max(...candles.slice(index - 39, index + 1).map((candle) => candle.high));
    if (index - candles.slice(index - 39, index + 1).map((candle) => candle.high).lastIndexOf(high40) > 10) continue;
    let pullbackLow = Infinity, touched = false;
    for (let cursor = Math.max(0, index - 3); cursor <= index; cursor++) {
      if (candles[cursor]!.low <= ema20[cursor]!) touched = true;
      pullbackLow = Math.min(pullbackLow, candles[cursor]!.low);
    }
    if (!touched || pullbackLow < ema50[index]! - 0.25 * currentAtr) continue;
    const pullbackVolume = candles.slice(Math.max(0, index - 3), index + 1).reduce((sum, candle) => sum + candle.volume, 0) / Math.min(4, index + 1);
    if (pullbackVolume >= volSma20[index]!) continue;
    if (!(current.close > current.open && current.close > candles[index - 1]!.high && current.close > ema20[index]!)) continue;
    lastSignal = index;
    const stop = Math.min(pullbackLow - 0.1 * currentAtr, current.close - 0.8 * currentAtr);
    const nextOpen = candles[index + 1]!.open;
    if (!passesGapGuard(current.close, nextOpen)) {
      trades.push({ signalDate: current.date, entryDate: candles[index + 1]!.date, exitDate: candles[index + 1]!.date, netPct: 0, outcome: "NO_FILL" });
      continue;
    }
    if (nextOpen <= stop) {
      trades.push({ signalDate: current.date, entryDate: candles[index + 1]!.date, exitDate: candles[index + 1]!.date, netPct: -2 * costPerSide * 100, outcome: "LOSS" });
      continue;
    }
    const risk = nextOpen - stop;
    if (risk <= 0 || risk > nextOpen * 0.08) continue;
    const trade = simulateLong(candles, index, stop, nextOpen + 2 * risk, 15, costPerSide);
    if (trade) trades.push(trade);
  }
  return trades;
}

export function meanReversion(series: Series, costPerSide: number, regime?: Set<string>): Trade[] {
  const candles = series.candles, close = candles.map((candle) => candle.close);
  const ema5 = ema(close, 5), ema40 = ema(close, 40), atr14 = atr(candles), rsi = rsi2(candles);
  const trades: Trade[] = [];
  let busyUntil = -1;
  for (let index = 41; index < candles.length - 11; index++) {
    if (regime && !regime.has(candles[index]!.date)) continue;
    if (index <= busyUntil || candles[index]!.close < 20 || candles[index]!.close <= ema40[index]! || rsi[index]! >= 10) continue;
    const turnover = candles.slice(index - 19, index + 1).reduce((sum, candle) => sum + candle.close * candle.volume, 0) / 20;
    if (turnover < 5e7) continue;
    const entry = candles[index]!.close;
    if (candles[index + 1]!.low > entry) { busyUntil = index + 1; continue; }
    busyUntil = index + 11;
    const stop = entry - 2 * atr14[index]!;
    const last = Math.min(index + 11, candles.length - 1);
    let exitDate = candles[last]!.date;
    let exit = candles[last]!.close;
    let outcome: Trade["outcome"] = "TIMEOUT";
    for (let cursor = index + 1; cursor <= last; cursor++) {
      if (candles[cursor]!.low <= stop) {
        exitDate = candles[cursor]!.date;
        exit = stop;
        outcome = "LOSS";
        break;
      }
      if (candles[cursor]!.close > ema5[cursor]! || rsi[cursor]! > 70) {
        exitDate = candles[cursor]!.date;
        exit = candles[cursor]!.close;
        outcome = exit > entry * (1 + 2 * costPerSide) ? "WIN" : "LOSS";
        break;
      }
    }
    trades.push({ signalDate: candles[index]!.date, entryDate: candles[index + 1]!.date, exitDate, netPct: (exit / entry - 1 - 2 * costPerSide) * 100, outcome });
  }
  return trades;
}

export function firstTradingDayOfMonth(candles: Candle[]): Set<string> {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const candle of candles) {
    const month = candle.date.slice(0, 7);
    if (!seen.has(month)) { seen.add(month); result.add(candle.date); }
  }
  return result;
}

export { median };
