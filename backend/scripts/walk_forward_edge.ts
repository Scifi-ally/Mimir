/**
 * Walk-forward validation of the edge filter.
 *
 * A single chronological split can flatter a filter by luck of the regime it
 * happened to hold out. This re-fits the cutoffs on each fold's training window
 * and scores them on the fold that follows, so every reported number is
 * out-of-sample and the result is an average across regimes rather than one.
 *
 * Reports the pooled out-of-sample expectancy (the number that matters) plus a
 * standard error, because at a few hundred trades the confidence interval is
 * wide and quoting a point estimate alone would overstate the confidence.
 *
 * Usage: npx tsx backend/scripts/walk_forward_edge.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RANKER_FEATURE_KEYS } from "../src/analysis/ranker_contract";

interface Row {
  ts: string;
  setupType?: string;
  label: number;
  retPct: number;
  features: number[];
}

const rows: Row[] = readFileSync(
  resolve(process.argv[2] ?? "backend/data/ranker_train.jsonl"),
  "utf-8",
)
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row)
  .filter((r) => r.ts && Array.isArray(r.features) && r.features.length >= 32)
  .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

const idx = (k: string) => RANKER_FEATURE_KEYS.indexOf(k);
const I = {
  atr14: idx("atr14"),
  realizedVol5: idx("realizedVol5"),
  ema200Dist: idx("ema200Dist"),
};
for (const [k, v] of Object.entries(I)) {
  if (v < 0) {
    console.error("missing feature: " + k);
    process.exit(1);
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function quantile(rs: Row[], fi: number, q: number): number {
  const vs = rs
    .map((r) => r.features[fi])
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  return vs[Math.floor(q * (vs.length - 1))]!;
}

function makeFilter(train: Row[]) {
  const atrMax = quantile(train, I.atr14, 0.2);
  const volMin = quantile(train, I.realizedVol5, 0.8);
  const emaMax = quantile(train, I.ema200Dist, 0.2);
  return (r: Row) =>
    r.features[I.atr14]! <= atrMax &&
    r.features[I.realizedVol5]! >= volMin &&
    r.features[I.ema200Dist]! >= emaMax;
}

const FOLDS = 6;
const TRAIN_FRAC = 0.5; // expanding or rolling? rolling 50% of the data

console.log(`rows ${rows.length}   folds ${FOLDS}`);
console.log("");

const oos: number[] = [];
const allOos: number[] = [];

for (let f = 0; f < FOLDS; f++) {
  const foldSize = Math.floor(rows.length / (FOLDS + 1));
  const trainStart = f * foldSize;
  const trainEnd = trainStart + foldSize;
  const testStart = trainEnd;
  const testEnd = testStart + foldSize;
  if (testEnd > rows.length) break;

  const train = rows.slice(trainStart, trainEnd);
  const test = rows.slice(testStart, testEnd);
  if (train.length < 200 || test.length < 100) continue;

  const filter = makeFilter(train);
  const kept = test.filter(filter);

  const allExp = mean(test.map((r) => r.retPct));
  const keptExp = kept.length ? mean(kept.map((r) => r.retPct)) : 0;
  oos.push(...kept.map((r) => r.retPct));
  allOos.push(...test.map((r) => r.retPct));

  const d = (s: Date) => s.toISOString().slice(0, 10);
  console.log(
    `fold ${f + 1}  train ${d(new Date(Date.parse(train[0]!.ts)))}..${d(new Date(Date.parse(train[train.length - 1]!.ts)))}  ` +
      `test ${d(new Date(Date.parse(test[0]!.ts)))}..${d(new Date(Date.parse(test[test.length - 1]!.ts)))}  ` +
      `kept ${String(kept.length).padStart(4)}/${String(test.length).padStart(4)}  ` +
      `all ${(allExp >= 0 ? "+" : "") + allExp.toFixed(3)}%  ` +
      `filtered ${kept.length ? (keptExp >= 0 ? "+" : "") + keptExp.toFixed(3) + "%" : "n/a"}`,
  );
}

console.log("");
console.log(`pooled out-of-sample trades: ${oos.length}`);
console.log(`  all rows      expectancy ${mean(allOos).toFixed(4)}%   n=${allOos.length}`);
console.log(`  filtered      expectancy ${mean(oos).toFixed(4)}%   n=${oos.length}`);

// Standard error of the mean, so the interval is visible rather than implied.
if (oos.length > 1) {
  const m = mean(oos);
  const sd = Math.sqrt(oos.reduce((a, b) => a + (b - m) ** 2, 0) / (oos.length - 1));
  const se = sd / Math.sqrt(oos.length);
  const lo = m - 1.96 * se;
  const hi = m + 1.96 * se;
  console.log(`  stdev ${sd.toFixed(3)}%   standard error ${se.toFixed(3)}%`);
  console.log(`  95% CI  [${lo.toFixed(3)}%, ${hi.toFixed(3)}%]`);
  console.log(lo > 0 ? "  interval excludes zero" : "  interval INCLUDES zero - not yet significant");
}