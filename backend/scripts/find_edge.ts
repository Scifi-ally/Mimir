/**
 * Is there ANY exploitable edge?
 *
 * The geometry sweep showed no target/hold combination reaches break-even. That
 * rules out sizing and timing, so the only remaining question is whether some
 * SUBSET of the signal population is positive. If one is, a filter - which the
 * setup-demotion mechanism already exists for - is a real improvement. If none
 * is, no amount of modelling will help and the honest answer is that the entry
 * signal has no edge.
 *
 * Method: bucket every row by each ranker feature and report expectancy per
 * decile. A feature whose top decile is materially better than the population
 * is a candidate filter. Also reports per-setup expectancy and the best
 * achievable outcome under an oracle filter, which is the upper bound any
 * real filter could reach.
 *
 * Usage: npx tsx backend/scripts/find_edge.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RANKER_FEATURE_KEYS } from "../src/analysis/ranker_contract";

interface Row {
  ts?: string;
  symbol?: string;
  setupType?: string;
  direction?: string;
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
  .map((l) => JSON.parse(l) as Row);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const overall = mean(rows.map((r) => r.retPct));
const hit = (xs: Row[]) => xs.length ? xs.filter((r) => r.label === 1).length / xs.length : 0;

console.log(`rows ${rows.length}   overall expectancy ${overall.toFixed(4)}%   hit ${(hit(rows) * 100).toFixed(1)}%`);
console.log("");

// ── Per setup ──────────────────────────────────────────────────────────────
console.log("Per setup:");
const bySetup = new Map<string, Row[]>();
for (const r of rows) {
  const k = r.setupType ?? "?";
  if (!bySetup.has(k)) bySetup.set(k, []);
  bySetup.get(k)!.push(r);
}
const setups = [...bySetup.entries()]
  .map(([k, rs]) => ({ k, n: rs.length, exp: mean(rs.map((r) => r.retPct)), hit: hit(rs) }))
  .sort((a, b) => b.exp - a.exp);
console.log("  setup                       rows    hit%   expectancy");
for (const s of setups) {
  console.log(`  ${s.k.padEnd(24)} ${String(s.n).padStart(6)} ${(s.hit * 100).toFixed(1).padStart(6)}%  ${s.exp >= 0 ? "+" : ""}${s.exp.toFixed(4)}%`);
}

const bestSetup = setups[0]!;
const worstSetup = setups[setups.length - 1]!;
console.log("");
console.log(`  best  ${bestSetup.k}: ${bestSetup.exp.toFixed(4)}%`);
console.log(`  worst ${worstSetup.k}: ${worstSetup.exp.toFixed(4)}%  (${worstSetup.n} rows, ${((worstSetup.n / rows.length) * 100).toFixed(0)}% of signals)`);

// ── Per feature decile ─────────────────────────────────────────────────────
// A real edge shows up as a monotonic-ish gradient where at least one tail
// decile is clearly above the population.
console.log("");
console.log("Feature decile scan (looking for a decile that is clearly better):");
const DECILES = 10;
const findings: Array<{ key: string; decile: number; exp: number; lift: number; n: number }> = [];

for (let fi = 0; fi < Math.min(RANKER_FEATURE_KEYS.length, 32); fi++) {
  const key = RANKER_FEATURE_KEYS[fi] ?? `f${fi}`;
  const vals = rows.map((r) => r.features[fi]).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (vals.length < rows.length * 0.5) continue;
  const sorted = [...vals].sort((a, b) => a - b);
  const cut = (q: number) => sorted[Math.floor(q * (sorted.length - 1))]!;

  for (let d = 0; d < DECILES; d++) {
    const lo = d === 0 ? -Infinity : cut(d / DECILES);
    const hi = d === DECILES - 1 ? Infinity : cut((d + 1) / DECILES);
    const bucket = rows.filter((r) => {
      const v = r.features[fi];
      return typeof v === "number" && Number.isFinite(v) && v >= lo && v < hi;
    });
    if (bucket.length < 150) continue;
    const exp = mean(bucket.map((r) => r.retPct));
    findings.push({ key, decile: d, exp, lift: exp - overall, n: bucket.length });
  }
}

findings.sort((a, b) => b.lift - a.lift);
console.log("  best 8 feature/decile buckets:");
console.log(`  ${"feature".padEnd(26)}${"decile".padStart(7)}     rows   expectancy     lift`);
for (const f of findings.slice(0, 8)) {
  console.log(
    `  ${f.key.padEnd(26)}${String(f.decile).padStart(7)}${String(f.n).padStart(8)}   ` +
      `${(f.exp >= 0 ? "+" : "") + f.exp.toFixed(4)}%   ${(f.lift >= 0 ? "+" : "") + f.lift.toFixed(4)}`,
  );
}

console.log("");
console.log("worst 3:");
for (const f of findings.slice(-3)) {
  console.log(
    `  ${f.key.padEnd(26)}${String(f.decile).padStart(7)}${String(f.n).padStart(8)}   ` +
      `${(f.exp >= 0 ? "+" : "") + f.exp.toFixed(4)}%   ${(f.lift >= 0 ? "+" : "") + f.lift.toFixed(4)}`,
  );
}

// ── Oracle upper bound ────────────────────────────────────────────────────
// Best achievable expectancy if a filter could pick exactly the right rows. No
// real filter reaches this, so it is a ceiling, not a forecast.
console.log("");
const ranked = [...rows].sort((a, b) => b.retPct - a.retPct);
for (const frac of [0.1, 0.25, 0.5, 0.75]) {
  const k = Math.floor(ranked.length * frac);
  console.log(
    `  oracle top ${(frac * 100).toFixed(0).padStart(2)}% of trades: expectancy ` +
      `${mean(ranked.slice(0, k).map((r) => r.retPct)).toFixed(4)}%`,
  );
}
console.log("");
console.log("An oracle is not a filter. This only bounds what any filter could reach.");
console.log("A realistic filter captures a fraction of the gap between the population");
console.log("mean and the oracle mean.");