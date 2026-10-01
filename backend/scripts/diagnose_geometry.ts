/**
 * Setup geometry diagnostics.
 *
 * Answers the question the ranker cannot: not "which features predict a win" but
 * "why is expectancy negative at all".
 *
 * The first run of this on the 17,407-row corpus found the actual cause:
 *
 *   - target1 is entry + 2.0 * risk (hardcoded in every detector)
 *   - the median WIN is +5.34%, which back-solves to a mean risk of ~2.67%
 *   - the mean LOSS is only -0.72%, i.e. 0.27R
 *
 * So the structure is: risk 2.67% of price per trade, capture 2R on 7.2% of
 * trades, and on the other 92.8% the trade does not reach the stop either - it
 * times out near flat and gives back only ~0.27R. Expectancy works out at
 *   0.072 * 5.34 - 0.928 * 0.72 = -0.28% per trade.
 *
 * The stop is very wide relative to what losers actually lose, and the target is
 * very far relative to what the hold window allows. That is the defect, and it is
 * a geometry problem rather than a modelling one - no feature set fixes it.
 *
 * Usage:
 *   npx tsx backend/scripts/diagnose_geometry.ts [path/to/ranker_train.jsonl]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Row {
  setupType?: string;
  label: number;
  retPct: number;
}

const path = resolve(process.argv[2] ?? "backend/data/ranker_train.jsonl");
const rows: Row[] = readFileSync(path, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);

if (!rows.length) {
  console.error("no rows in " + path);
  process.exit(1);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const wins = rows.filter((r) => r.label === 1);
const losses = rows.filter((r) => r.label === 0);
const hitRate = wins.length / rows.length;

const winRets = wins.map((r) => r.retPct).sort((a, b) => a - b);
const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : 0);
const pct = (xs: number[], q: number) => (xs.length ? xs[Math.floor(q * (xs.length - 1))] : 0);

console.log(`rows            : ${rows.length}`);
console.log(`hit rate        : ${(hitRate * 100).toFixed(1)}%  (${wins.length} / ${rows.length})`);
console.log(`median win      : +${median(winRets).toFixed(2)}%`);
console.log(`mean loss       : ${mean(losses.map((r) => r.retPct)).toFixed(2)}%`);
console.log(`expectancy      : ${mean(rows.map((r) => r.retPct)).toFixed(4)}% per trade`);
console.log("");

// The implied risk per trade, back-solved from the observed win magnitude.
// target1 is 2.0 * risk in every detector, so a median win of X% implies a mean
// risk of X/2. Comparing that against the mean loss is what exposes a stop that
// is far wider than the losses it is supposed to bound.
const impliedRisk = median(winRets) / 2;
const meanLoss = Math.abs(mean(losses.map((r) => r.retPct)));
console.log(`implied risk/trade (from 2R target): ${impliedRisk.toFixed(2)}%`);
console.log(`mean loss as R                     : ${(meanLoss / impliedRisk).toFixed(2)}R`);
console.log("");

// Where the losing returns come from. A bucket far past the stop is either a gap
// or a timeout that ended badly; a bucket slightly positive is a trade that made
// money but never reached the target, which the target-based label calls a loss.
console.log("Loss distribution (label = 0):");

const buckets: Array<[string, (v: number) => boolean]> = [
  ["<= -2x risk      (gapped / blown out)", (v) => v <= -2 * impliedRisk],
  ["-2x to -1x risk  (stop region)", (v) => v <= -impliedRisk && v > -2 * impliedRisk],
  ["-1x to -0.3x risk", (v) => v <= -0.3 * impliedRisk && v > -impliedRisk],
  ["near flat, slight loss", (v) => v < 0 && v > -0.3 * impliedRisk],
  ["flat to +0.3x risk (no target hit)", (v) => v >= 0 && v < 0.3 * impliedRisk],
  [">= +0.3x risk    (up, but no target)", (v) => v >= 0.3 * impliedRisk],
];
for (const [label, pred] of buckets) {
  const n = losses.filter((r) => pred(r.retPct)).length;
  console.log(`  ${label.padEnd(38)} ${String(n).padStart(6)}  ${((n / losses.length) * 100).toFixed(1)}%`);
}

const upButNoTarget = losses.filter((r) => r.retPct > 0).length;
console.log("");
console.log(
  `${upButNoTarget} of ${losses.length} non-target exits ` +
    `(${((upButNoTarget / losses.length) * 100).toFixed(1)}%) closed PROFITABLE ` +
    `but are labelled 0,`,
);
console.log("because the label is 'reached target1', not 'was profitable'.");

// Break-even arithmetic at the current payout.
const payoff = median(winRets) / meanLoss;
console.log("");
console.log(`payoff ratio (median win / mean loss): ${payoff.toFixed(2)} : 1`);
console.log(`break-even hit rate at that payout   : ${(100 / (1 + payoff)).toFixed(1)}%`);
console.log(`actual hit rate                     : ${(hitRate * 100).toFixed(1)}%`);
console.log("");
console.log(
  `At ${payoff.toFixed(2)}:1 payout, a ${(hitRate * 100).toFixed(1)}% hit rate is ` +
    `worth ${mean(rows.map((r) => r.retPct)).toFixed(3)}% per trade.`,
);

// Per-setup, since the geometry is hardcoded per detector.
console.log("");
console.log("setup                        rows    hit%   meanRet   meanWin  meanLoss");
const bySetup = new Map<string, Row[]>();
for (const r of rows) {
  const k = r.setupType ?? "?";
  if (!bySetup.has(k)) bySetup.set(k, []);
  bySetup.get(k)!.push(r);
}
[...bySetup.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 14)
  .forEach(([setup, rs]) => {
    const w = rs.filter((r) => r.label === 1);
    const l = rs.filter((r) => r.label === 0);
    const name = setup.slice(0, 26).padEnd(26);
    const n = String(rs.length).padStart(6);
    const hit = `${((w.length / rs.length) * 100).toFixed(1)}%`.padStart(6);
    console.log(
      `${name} ${n} ${hit} ` +
        `${mean(rs.map((r) => r.retPct)).toFixed(3).padStart(9)} ` +
        `${mean(w.map((r) => r.retPct)).toFixed(3).padStart(9)} ` +
        `${mean(l.map((r) => r.retPct)).toFixed(3).padStart(9)}`,
    );
  });

void pct;