/**
 * Does an edge-based filter actually help, out of sample?
 *
 * find_edge.ts found buckets with positive expectancy - low atr14, high
 * realizedVol5, high vcpContraction, and avoiding the lowest deciles of
 * ema20Dist / ema200Dist / rsi14. A filter chosen by scanning a dataset and
 * then scored on that same dataset is in-sample and will always look good, so
 * this splits chronologically: derive the cutoffs on the EARLY period only, then
 * score them unchanged on the LATE period it never saw.
 *
 * The reported number is the late-period result. That is the only one worth
 * believing.
 *
 * Usage: npx tsx backend/scripts/validate_edge_filter.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RANKER_FEATURE_KEYS } from "../src/analysis/ranker_contract";

interface Row {
  ts: string;
  symbol: string;
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

const idx = (key: string) => RANKER_FEATURE_KEYS.indexOf(key);
const I = {
  atr14: idx("atr14"),
  realizedVol5: idx("realizedVol5"),
  vcpContraction: idx("vcpContraction"),
  ema20Dist: idx("ema20Dist"),
  ema200Dist: idx("ema200Dist"),
  rsi14: idx("rsi14"),
};
for (const [k, v] of Object.entries(I)) {
  if (v < 0) {
    console.error("feature not found in contract: " + k);
    process.exit(1);
  }
}

const SPLIT = 0.7;
const cut = Math.floor(rows.length * SPLIT);
const train = rows.slice(0, cut);
const test = rows.slice(cut);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rate = (xs: Row[]) => xs.length ? xs.filter((r) => r.label === 1).length / xs.length : 0;

function report(name: string, rs: Row[]) {
  if (!rs.length) {
    console.log(`  ${name.padEnd(22)} n=0`);
    return;
  }
  const exp = mean(rs.map((r) => r.retPct));
  console.log(
    `  ${name.padEnd(22)} n=${String(rs.length).padStart(5)}  hit ${(rate(rs) * 100).toFixed(1).padStart(4)}%  ` +
      `expectancy ${(exp >= 0 ? "+" : "") + exp.toFixed(4)}%`,
  );
}

console.log(`rows ${rows.length}   train ${train.length}   TEST ${test.length} (held out)`);
console.log(`train ends  ${new Date(Date.parse(train[train.length - 1]!.ts)).toISOString().slice(0, 10)}`);
console.log(`test starts ${new Date(Date.parse(test[0]!.ts)).toISOString().slice(0, 10)}`);
console.log("");

// ── Derive cutoffs on TRAIN only ───────────────────────────────────────────
function quantile(rs: Row[], fi: number, q: number): number {
  const vs = rs.map((r) => r.features[fi]).filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  return vs[Math.floor(q * (vs.length - 1))]!;
}

const cutoffs = {
  atr14Max: quantile(train, I.atr14, 0.2),          // lowest quintile was best
  realizedVol5Min: quantile(train, I.realizedVol5, 0.8), // highest quintile was best
  vcpContractionMin: quantile(train, I.vcpContraction, 0.8),
  ema20DistMin: quantile(train, I.ema20Dist, 0.2),  // lowest quintile was worst
  ema200DistMin: quantile(train, I.ema200Dist, 0.2),
  rsi14Min: quantile(train, I.rsi14, 0.2),
};

console.log("Cutoffs derived on TRAIN only:");
for (const [k, v] of Object.entries(cutoffs)) console.log(`  ${k.padEnd(22)} ${v.toFixed(4)}`);
console.log("");

// ── The filter ─────────────────────────────────────────────────────────────
// Kept deliberately small. Every extra condition is another chance to fit noise,
// and with a 7.2% base hit rate a thin sample is easy to overfit.
function passes(r: Row): boolean {
  const f = r.features;
  return (
    f[I.atr14]! <= cutoffs.atr14Max &&
    f[I.realizedVol5]! >= cutoffs.realizedVol5Min &&
    f[I.ema200Dist]! >= cutoffs.ema200DistMin
  );
}

const trainKept = train.filter(passes);
const testKept = test.filter(passes);

console.log("TRAIN (cutoffs fitted here - optimistic by construction):");
report("all", train);
report("filtered", trainKept);
report("removed", train.filter((r) => !passes(r)));
console.log("");
console.log("TEST (never seen; this is the number that matters):");
report("all", test);
report("filtered", testKept);
report("removed", test.filter((r) => !passes(r)));

const allExp = mean(test.map((r) => r.retPct));
const filtExp = mean(testKept.map((r) => r.retPct));
console.log("");
console.log(`  TEST expectancy: all ${allExp.toFixed(4)}%  ->  filtered ${filtExp.toFixed(4)}%`);
if (allExp !== 0) {
  console.log(`  improvement    : ${(((filtExp - allExp) / Math.abs(allExp)) * 100).toFixed(0)}%`);
}
console.log("");

if (filtExp > 0 && testKept.length >= 100) {
  console.log(`  POSITIVE out of sample on ${testKept.length} trades.`);
  console.log("  Still thin: 100-odd trades cannot distinguish +0.1% from +0.4%.");
  console.log("  Needs a walk-forward split across several periods before it is trusted.");
} else if (filtExp > 0) {
  console.log(`  Positive but on only ${testKept.length} trades - too thin to trust.`);
} else {
  console.log("  NOT positive out of sample. The in-sample lift did not survive.");
  console.log("  That is the expected outcome of filtering on the same data, and it");
  console.log("  means these buckets were noise rather than signal.");
}