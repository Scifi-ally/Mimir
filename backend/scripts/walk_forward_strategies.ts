import fs from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { candlesTable, db, pool } from "../db/src";
import { DELIVERY_COST_RATE_PER_SIDE, resolveCostPerSide } from "../src/lib/trading_costs";

type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type Series = { key: string; candles: Candle[] };
type Trade = { date: string; exitDate: string; netPct: number; win: boolean };
type StrategyResult = {
  strategy: string;
  folds: Array<Record<string, unknown>>;
  overall: Record<string, unknown>;
  pass: boolean;
};

const COST = resolveCostPerSide(process.argv, DELIVERY_COST_RATE_PER_SIDE);
const FOLD_YEARS = [2022, 2023, 2024, 2025];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function ema(values: number[], period: number): number[] {
  const out = values.map((value) => value);
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out[i] = values[i]! * k + out[i - 1]! * (1 - k);
  return out;
}

function atr(s: Candle[], period = 14): number[] {
  const out = new Array<number>(s.length).fill(0);
  for (let i = 1; i < s.length; i++) {
    const tr = Math.max(s[i]!.high - s[i]!.low, Math.abs(s[i]!.high - s[i - 1]!.close), Math.abs(s[i]!.low - s[i - 1]!.close));
    out[i] = i <= period ? (out[i - 1]! * (i - 1) + tr) / i : (out[i - 1]! * (period - 1) + tr) / period;
  }
  return out;
}

function rsi2(s: Candle[]): number[] {
  return s.map((_, i) => {
    if (i < 2) return NaN;
    const one = s[i]!.close - s[i - 1]!.close;
    const two = s[i - 1]!.close - s[i - 2]!.close;
    const gains = [one, two].filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const losses = [one, two].filter((value) => value < 0).reduce((sum, value) => sum - value, 0);
    return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function net(gross: number): number {
  return (gross - 2 * COST) * 100;
}

function simulateLong(s: Candle[], signal: number, stop: number | null, holdBars: number): Trade | null {
  const entryBar = signal + 1;
  if (!s[entryBar] || !Number.isFinite(s[entryBar].open)) return null;
  const entry = s[entryBar].open;
  const last = Math.min(entryBar + holdBars - 1, s.length - 1);
  for (let i = entryBar; i <= last; i++) {
    if (stop != null) {
      if (s[i]!.open <= stop) return { date: s[signal]!.date, exitDate: s[i]!.date, netPct: net(s[i]!.open / entry - 1), win: false };
      if (s[i]!.low <= stop) return { date: s[signal]!.date, exitDate: s[i]!.date, netPct: net(stop / entry - 1), win: false };
    }
  }
  const exit = s[last]!.close;
  const result = net(exit / entry - 1);
  return { date: s[signal]!.date, exitDate: s[last]!.date, netPct: result, win: result > 0 };
}

function pullback(s: Candle[], regimeGate: boolean): Trade[] {
  const close = s.map((c) => c.close);
  const e20 = ema(close, 20), e50 = ema(close, 50), a = atr(s);
  const trades: Trade[] = [];
  for (let i = 55; i < s.length - 16; i++) {
    if (regimeGate && close[i]! <= e50[i]!) continue;
    let high40 = -Infinity;
    for (let j = i - 39; j <= i; j++) high40 = Math.max(high40, s[j]!.high);
    let age = 0;
    while (i - age >= 0 && s[i - age]!.high < high40) age++;
    if (!(e20[i]! > e50[i]! && close[i]! > e50[i]! && e50[i]! > e50[i - 10]! && age <= 10)) continue;
    if (i < 1 || s[i]!.close <= s[i - 1]!.high) continue;
    const stop = Math.min(s[i - 1]!.low, s[i]!.low) - 0.8 * a[i]!;
    const entry = s[i + 1]!.open;
    const risk = entry - stop;
    if (!(risk > 0) || risk > entry * 0.08) continue;
    const target = entry + 2 * risk;
    const trade = simulateLong(s, i, stop, 15);
    if (!trade) continue;
    if (trade.netPct === net(stop / entry - 1)) trades.push(trade);
    else {
      for (let j = i + 1; j <= Math.min(i + 15, s.length - 1); j++) {
        if (s[j]!.high >= target) {
          const result = net(target / entry - 1);
          trades[trades.length] = { date: s[i]!.date, exitDate: s[j]!.date, netPct: result, win: result > 0 };
          break;
        }
      }
      if (trades.length === 0 || trades[trades.length - 1]!.date !== s[i]!.date) trades.push(trade);
    }
  }
  return trades;
}

function meanReversion(s: Candle[], regimeGate: boolean): Trade[] {
  const close = s.map((c) => c.close), e5 = ema(close, 5), e40 = ema(close, 40), a = atr(s), rsi = rsi2(s);
  const trades: Trade[] = [];
  for (let i = 41; i < s.length - 11; i++) {
    if (regimeGate && close[i]! <= e40[i]!) continue;
    if (!(rsi[i]! < 10 && close[i]! > e40[i]!)) continue;
    const entry = close[i]!;
    if (s[i + 1]!.low > entry) continue;
    const stop = entry - 2 * a[i]!;
    let exit = s[Math.min(i + 11, s.length - 1)]!;
    for (let j = i + 1; j <= Math.min(i + 10, s.length - 1); j++) {
      if (s[j]!.low <= stop) { exit = { ...s[j]!, close: stop }; break; }
      if (s[j]!.close > e5[j]! || rsi[j]! > 70) { exit = s[j]!; break; }
    }
    const result = net(exit.close / entry - 1);
    trades.push({ date: s[i]!.date, exitDate: exit.date, netPct: result, win: result > 0 });
  }
  return trades;
}

function crossSectionalMomentum(universe: Series[], regimeGate: boolean): Trade[] {
  const trades: Trade[] = [];
  const candidates: Array<{ series: Series; index: number; score: number }> = [];
  for (const series of universe) {
    const close = series.candles.map((candle) => candle.close);
    const e50 = ema(close, 50);
    for (let i = 252; i < series.candles.length - 22; i++) {
      if (series.candles[i]!.date.slice(8) > "07") continue;
      if (regimeGate && close[i]! <= e50[i]!) continue;
      const turnover = series.candles.slice(i - 20, i).map((candle) => candle.close * candle.volume);
      if (median(turnover) < 50_000_000) continue;
      const score = close[i - 21]! / close[i - 252]! - 1;
      if (Number.isFinite(score)) candidates.push({ series, index: i, score });
    }
  }
  const byDate = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const date = candidate.series.candles[candidate.index]!.date;
    byDate.set(date, [...(byDate.get(date) ?? []), candidate]);
  }
  for (const group of byDate.values()) {
    group.sort((a, b) => b.score - a.score);
    const selected = group.slice(0, Math.max(1, Math.ceil(group.length / 10)));
    for (const candidate of selected) {
      const s = candidate.series.candles;
      const entry = s[candidate.index + 1]!.open;
      const exit = s[candidate.index + 21]!.close;
      const result = net(exit / entry - 1);
      trades.push({ date: s[candidate.index]!.date, exitDate: s[candidate.index + 21]!.date, netPct: result, win: result > 0 });
    }
  }
  return trades;
}

function stats(trades: Trade[], benchmark: Map<string, number>): Record<string, unknown> {
  const daily = new Map<string, number>();
  for (const trade of trades) daily.set(trade.exitDate, (daily.get(trade.exitDate) ?? 0) + trade.netPct - (benchmark.get(trade.exitDate) ?? 0));
  const values = [...daily.values()];
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
  const t = values.length > 1 && variance > 0 ? mean / Math.sqrt(variance / values.length) : 0;
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const trade of trades) { equity *= 1 + trade.netPct / 100; peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, (equity / peak - 1) * 100); }
  const months = new Map<string, number>();
  for (const trade of trades) { const month = trade.exitDate.slice(0, 7); months.set(month, (months.get(month) ?? 0) + trade.netPct); }
  return {
    fills: trades.length,
    winRatePct: trades.length ? trades.filter((trade) => trade.win).length / trades.length * 100 : 0,
    expectancyPct: trades.length ? trades.reduce((sum, trade) => sum + trade.netPct, 0) / trades.length : 0,
    alphaPct: values.reduce((sum, value) => sum + value, 0),
    dayClusteredAlphaT: t,
    maxDrawdownPct: maxDrawdown,
    worstMonthPct: months.size ? Math.min(...months.values()) : 0,
  };
}

async function main(): Promise<void> {
  const regimeGate = process.argv.includes("--regimeGate");
  const rows = await db.select().from(candlesTable).where(eq(candlesTable.interval, "day")).orderBy(asc(candlesTable.timestamp));
  const grouped = new Map<string, Series>();
  for (const row of rows) {
    const series = grouped.get(row.instrumentKey) ?? { key: row.instrumentKey, candles: [] };
    series.candles.push({ date: row.timestamp.toISOString().slice(0, 10), open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
    grouped.set(row.instrumentKey, series);
  }
  const all = [...grouped.values()];
  const universe = new Map<string, number>();
  for (const s of all) for (let i = 1; i < s.candles.length; i++) universe.set(s.candles[i]!.date, (universe.get(s.candles[i]!.date) ?? 0) + s.candles[i]!.close / s.candles[i - 1]!.close - 1);
  const benchmark = new Map([...universe].map(([date, value]) => [date, value * 100]));
  const factories: Array<[string, (s: Candle[], gate: boolean) => Trade[]]> = [["pullback", pullback], ["mean_reversion", meanReversion]];
  const results: StrategyResult[] = factories.map(([name, run]) => {
    const folds = FOLD_YEARS.map((year) => {
      const trades = all.flatMap((series) => run(series.candles, regimeGate).filter((trade) => trade.exitDate.startsWith(String(year))));
      const result = stats(trades, benchmark);
      return { year, ...result, positive: Number(result.expectancyPct) > 0 };
    });
    const trades = all.flatMap((series) => run(series.candles, regimeGate));
    const overall = stats(trades, benchmark);
    const pass = Number(overall.dayClusteredAlphaT) >= 2 && folds.filter((fold) => fold.positive).length >= 3 && Number(overall.worstMonthPct) >= -2;
    return { strategy: name, folds, overall, pass };
  });
  const momentumTrades = crossSectionalMomentum(all, regimeGate);
  const momentumFolds = FOLD_YEARS.map((year) => {
    const foldTrades = momentumTrades.filter((trade) => trade.exitDate.startsWith(String(year)));
    return { year, ...stats(foldTrades, benchmark), positive: foldTrades.some((trade) => trade.netPct > 0) };
  });
  const momentumOverall = stats(momentumTrades, benchmark);
  results.splice(1, 0, {
    strategy: "momentum_12_1",
    folds: momentumFolds,
    overall: momentumOverall,
    pass: Number(momentumOverall.dayClusteredAlphaT) >= 2
      && momentumFolds.filter((fold) => fold.positive).length >= 3
      && Number(momentumOverall.worstMonthPct) >= -2,
  });
  const outputDir = arg("outputDir") ?? path.resolve(process.cwd(), "reports");
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "walk_forward_strategies.json");
  const mdPath = path.join(outputDir, "walk_forward_strategies.md");
  fs.writeFileSync(jsonPath, JSON.stringify({ costPerSide: COST, regimeGate, results }, null, 2));
  const markdown = ["# Walk-forward strategy results", "", `Cost: ${(COST * 100).toFixed(3)}%/side`, `Regime gate: ${regimeGate ? "enabled" : "disabled"}`, "", "| Strategy | Fills | Win % | Expectancy % | Alpha t | Max DD % | Worst month % | PASS |", "|---|---:|---:|---:|---:|---:|---:|---|"];
  for (const result of results) {
    const o = result.overall as Record<string, number>;
    markdown.push(`| ${result.strategy} | ${o.fills} | ${o.winRatePct.toFixed(2)} | ${o.expectancyPct.toFixed(3)} | ${o.dayClusteredAlphaT.toFixed(2)} | ${o.maxDrawdownPct.toFixed(2)} | ${o.worstMonthPct.toFixed(2)} | ${result.pass ? "PASS" : "FAIL"} |`);
  }
  fs.writeFileSync(mdPath, `${markdown.join("\n")}\n`);
  console.log(markdown.join("\n"));
  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
