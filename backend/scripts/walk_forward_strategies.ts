import fs from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { candlesTable, db, pool } from "../db/src";
import { DELIVERY_COST_RATE_PER_SIDE, resolveCostPerSide } from "../src/lib/trading_costs";
import { equalWeightIndex, matchedWindowAlpha, meanReversion, median, pullback, type Series, type Trade } from "./walk_forward_strategies_lib";

const COST = resolveCostPerSide(process.argv, DELIVERY_COST_RATE_PER_SIDE);
const FOLD_YEARS = [2022, 2023, 2024, 2025];
type Metrics = { fills: number; winRatePct: number; expectancyPct: number; alphaPct: number; dayClusteredAlphaT: number; maxDrawdownPct: number; worstMonthPct: number };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function momentum(series: Series[], costPerSide: number, benchmark: Map<string, number>, regimeGate: boolean): Trade[] {
  const calendar = [...new Set(series.flatMap((item) => item.candles.map((candle) => candle.date)))].sort();
  const rebalanceDates = new Set(calendar.filter((date, index) => index === 0 || date.slice(0, 7) !== calendar[index - 1]!.slice(0, 7)));
  const regime = new Set<string>();
  if (regimeGate) {
    for (let index = 50; index < calendar.length; index++) {
      const values = calendar.slice(index - 49, index + 1).map((date) => benchmark.get(date) ?? NaN);
      const ema50 = values.reduce((sum, value) => sum + value, 0) / values.length;
      if ((benchmark.get(calendar[index]!) ?? 0) > ema50) regime.add(calendar[index]!);
    }
  }
  const trades: Trade[] = [];
  for (const date of rebalanceDates) {
    if (regimeGate && !regime.has(date)) continue;
    const candidates: Array<{ series: Series; index: number; score: number }> = [];
    for (const item of series) {
      const index = item.candles.findIndex((candle) => candle.date === date);
      if (index < 252 || index + 21 >= item.candles.length) continue;
      const past = item.candles[index - 252]!.close;
      const turnover = median(item.candles.slice(index - 20, index).map((candle) => candle.close * candle.volume));
      if (!(past > 0) || turnover < 50_000_000) continue;
      candidates.push({ series: item, index, score: item.candles[index - 21]!.close / past - 1 });
    }
    candidates.sort((left, right) => right.score - left.score);
    for (const candidate of candidates.slice(0, Math.max(1, Math.ceil(candidates.length / 10)))) {
      const entry = candidate.series.candles[candidate.index + 1]!;
      const exit = candidate.series.candles[candidate.index + 21]!;
      const netPct = (exit.close / entry.open - 1 - 2 * costPerSide) * 100;
      trades.push({ signalDate: date, entryDate: entry.date, exitDate: exit.date, netPct, outcome: netPct > 0 ? "WIN" : "LOSS" });
    }
  }
  return trades;
}

function metrics(trades: Trade[], benchmark: Map<string, number>): Metrics {
  const filled = trades.filter((trade) => trade.outcome !== "NO_FILL");
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const alphas = filled.map((trade) => matchedWindowAlpha(trade, benchmark)).filter((value): value is number => value != null);
  const byDay = new Map<string, number[]>();
  for (const trade of filled) {
    const alpha = matchedWindowAlpha(trade, benchmark);
    if (alpha != null) (byDay.get(trade.signalDate) ?? byDay.set(trade.signalDate, []).get(trade.signalDate)!).push(alpha);
  }
  const dayMeans = [...byDay.values()].map(mean);
  const dayMean = mean(dayMeans);
  const sd = dayMeans.length > 1 ? Math.sqrt(mean(dayMeans.map((value) => (value - dayMean) ** 2)) * dayMeans.length / (dayMeans.length - 1)) : 0;
  const daily = new Map<string, number[]>();
  for (const trade of filled) (daily.get(trade.exitDate) ?? daily.set(trade.exitDate, []).get(trade.exitDate)!).push(trade.netPct);
  let equity = 1, peak = 1, drawdown = 0;
  for (const values of [...daily.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, values]) => mean(values))) {
    equity *= 1 + values / 100;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, (equity / peak - 1) * 100);
  }
  const months = new Map<string, number[]>();
  for (const trade of filled) (months.get(trade.exitDate.slice(0, 7)) ?? months.set(trade.exitDate.slice(0, 7), []).get(trade.exitDate.slice(0, 7))!).push(trade.netPct);
  return { fills: filled.length, winRatePct: filled.length ? filled.filter((trade) => trade.netPct > 0).length / filled.length * 100 : 0, expectancyPct: mean(filled.map((trade) => trade.netPct)), alphaPct: mean(alphas), dayClusteredAlphaT: sd ? dayMean / (sd / Math.sqrt(dayMeans.length)) : 0, maxDrawdownPct: drawdown, worstMonthPct: months.size ? Math.min(...[...months.values()].map(mean)) : 0 };
}

function render(results: Array<{ strategy: string; folds: Array<{ year: number; metrics: Metrics; positive: boolean }>; overall: Metrics; pass: boolean }>): string {
  const lines = ["# Walk-forward strategy results", "", `Cost: ${(COST * 100).toFixed(3)}%/side`, "", "| Strategy | Fold | Fills | Win % | Expectancy % | Alpha % | Alpha t | Max DD % | Worst month % | PASS |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|"];
  for (const result of results) {
    for (const fold of result.folds) {
      const m = fold.metrics;
      lines.push(`| ${result.strategy} | ${fold.year} | ${m.fills} | ${m.winRatePct.toFixed(2)} | ${m.expectancyPct.toFixed(3)} | ${m.alphaPct.toFixed(3)} | ${m.dayClusteredAlphaT.toFixed(2)} | ${m.maxDrawdownPct.toFixed(2)} | ${m.worstMonthPct.toFixed(2)} | ${fold.positive ? "PASS" : "FAIL"} |`);
    }
    const m = result.overall;
    lines.push(`| ${result.strategy} | overall | ${m.fills} | ${m.winRatePct.toFixed(2)} | ${m.expectancyPct.toFixed(3)} | ${m.alphaPct.toFixed(3)} | ${m.dayClusteredAlphaT.toFixed(2)} | ${m.maxDrawdownPct.toFixed(2)} | ${m.worstMonthPct.toFixed(2)} | ${result.pass ? "PASS" : "FAIL"} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const regimeGate = process.argv.includes("--regimeGate");
  const rows = await db.select().from(candlesTable).where(eq(candlesTable.interval, "day")).orderBy(asc(candlesTable.instrumentKey), asc(candlesTable.timestamp));
  const grouped = new Map<string, Series>();
  for (const row of rows) {
    const series = grouped.get(row.instrumentKey) ?? { key: row.instrumentKey, candles: [] };
    series.candles.push({ date: row.timestamp.toISOString().slice(0, 10), open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
    grouped.set(row.instrumentKey, series);
  }
  const series = [...grouped.values()];
  const benchmark = equalWeightIndex(series);
  const runs = [["pullback", series.flatMap((item) => pullback(item, COST))], ["mean_reversion", series.flatMap((item) => meanReversion(item, COST))], ["momentum_12_1", momentum(series, COST, benchmark, regimeGate)]] as const;
  const results = runs.map(([strategy, trades]) => {
    const folds = FOLD_YEARS.map((year) => {
      const foldMetrics = metrics(trades.filter((trade) => trade.exitDate.startsWith(String(year))), benchmark);
      return { year, metrics: foldMetrics, positive: foldMetrics.expectancyPct > 0 };
    });
    const overall = metrics(trades, benchmark);
    return { strategy, folds, overall, pass: overall.dayClusteredAlphaT >= 2 && folds.filter((fold) => fold.positive).length >= 3 && overall.worstMonthPct >= -2 };
  });
  const outputDir = arg("outputDir") ?? path.resolve(process.cwd(), "reports");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "walk_forward_strategies.json"), JSON.stringify({ costPerSide: COST, regimeGate, results }, null, 2));
  fs.writeFileSync(path.join(outputDir, "walk_forward_strategies.md"), render(results));
  console.log(render(results));
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
