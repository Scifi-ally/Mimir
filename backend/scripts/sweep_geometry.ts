/**
 * Setup geometry sweep.
 *
 * Answers the question the diagnostic raised: at what target width, stop width
 * and hold window does this corpus become profitable?
 *
 * Why re-label rather than re-extract: re-running the detectors over 97
 * instruments x ~1200 bars for every combination of parameters is expensive and
 * changes the setup population each time, which makes the grid incomparable.
 * Instead each existing training row is replayed forward from its own timestamp
 * with new geometry, holding the signal population fixed. That isolates the
 * geometry effect, which is what we want to measure.
 *
 * APPROXIMATION, stated plainly: entry is the close on the signal bar and risk
 * is ATR-derived, whereas the detectors use a structural stop (swing low /
 * superTrend) and their own entry. So absolute numbers here will not match the
 * extractor's exactly. The grid is for ranking geometry against itself -
 * "does a 1.2R target beat a 2R target on the same signals?" - not for quoting
 * an expected return.
 *
 * Usage:
 *   npx tsx backend/scripts/sweep_geometry.ts [rows.jsonl]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rowsPath = resolve(process.argv[2] ?? "backend/data/ranker_train.jsonl");
const COST_RATE_PER_SIDE = 0.0005; // mirrors extract_training_data.ts

interface Row {
  ts?: string | number;
  symbol?: string;
  setupType?: string;
  direction?: string;
  /**
   * The flat 32-value ranker vector, in RANKER_FEATURE_KEYS order - NOT an
   * object. Index 1 is atr14. Reading `features.atr14` yields undefined for every
   * row, which makes the sweep skip everything and print an empty grid that
   * looks like a clean result rather than a broken join.
   */
  features?: number[];
}
const ATR14_INDEX = 1;

const TARGET_MULTIPLES = [1.0, 1.2, 1.5, 2.0, 2.5, 3.0];
const HOLD_BARS = [5, 10, 15, 20, 30];
const ATR_RISK_MULT = 1.8; // matches the detectors' atr stop leg

// ── Load candles straight from the DB cache the extractor uses ──────────────
// Kept dependency-free on purpose: this has to run before anything else is
// changed, and a schema or client change should not be able to block measuring
// the geometry.
/**
 * A bar is a tuple, not an object: [t, o, h, l, c, v].
 * Reading b.t or bars[i].c yields undefined and the whole sweep silently
 * matches nothing, which looks exactly like a clean negative result.
 */
const T = 0, O = 1, H = 2, L = 3, C = 4;

interface Bar extends Array<number> {}

async function loadCandles(): Promise<Map<string, Bar[]>> {
  const rows = readFileSync("backend/data/candles_cache.json", "utf-8");
  const parsed = JSON.parse(rows) as Record<string, Bar[]>;
  const out = new Map<string, Bar[]>();
  for (const [k, v] of Object.entries(parsed)) {
    if (Array.isArray(v) && v.length) out.set(k, v);
  }
  return out;
}

const rows: Row[] = readFileSync(rowsPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);

const withBars = rows.filter((r) => r.ts != null && r.symbol != null);
console.log(`rows            : ${rows.length}`);
console.log(`rows with a ts  : ${withBars.length}`);
console.log(`target multiples: ${TARGET_MULTIPLES.join(", ")}`);
console.log(`hold windows    : ${HOLD_BARS.join(", ")} bars`);
console.log("");

const candles = await loadCandles().catch(() => new Map<string, Bar[]>());
console.log(`symbols loaded  : ${candles.size}`);
if (candles.size === 0) {
  console.log("");
  console.log("No candle cache found at backend/data/candles_cache.json.");
  console.log("Export the `candles` table to that path first:");
  console.log("  psql ... -c \"select instrument_key, array_agg(...) ...\" > backend/data/candles_cache.json");
}
console.log("");

/**
 * Replay one signal forward under the given geometry.
 * Mirrors labelTrade() in extract_training_data.ts: stop is checked before
 * target on each bar (conservative), and an unfilled trade is dropped.
 */
function replay(
  bars: Bar[],
  startIdx: number,
  isBuy: boolean,
  entry: number,
  stop: number,
  target: number,
  hold: number,
): number | null {
  for (let k = startIdx + 1; k <= Math.min(bars.length - 1, startIdx + hold); k++) {
    const b = bars[k]!;
    // Tuple access. With object-style access b.o/b.l/b.h are all undefined, so
    // every comparison is false, neither stop nor target is ever hit, and every
    // trade silently falls through to the timeout exit. The tell was every
    // target multiple returning an identical expectancy.
    const gappedStop = isBuy ? b[O]! <= stop : b[O]! >= stop;
    const stopHit = isBuy ? b[L]! <= stop : b[H]! >= stop;
    const targetHit = isBuy ? b[H]! >= target : b[L]! <= target;
    if (gappedStop || stopHit) {
      const gross = isBuy ? (stop - entry) / entry : (entry - stop) / entry;
      return (gross - 2 * COST_RATE_PER_SIDE) * 100;
    }
    if (targetHit) {
      const gross = isBuy ? (target - entry) / entry : (entry - target) / entry;
      return (gross - 2 * COST_RATE_PER_SIDE) * 100;
    }
  }
  const exitBar = bars[Math.min(bars.length - 1, startIdx + hold)];
  if (!exitBar) return null;
  const gross = isBuy ? (exitBar[C] - entry) / entry : (entry - exitBar[C]) / entry;
  return (gross - 2 * COST_RATE_PER_SIDE) * 100;
}

// ── Sweep ──────────────────────────────────────────────────────────────────
/**
 * Bar index per symbol, plus a nearest-bar lookup.
 *
 * Exact equality on the timestamp is not enough: the training rows carry the
 * signal bar as an ISO instant (03:45 UTC, the NSE open) while the candles table
 * stores whatever timezone the row was written in, so the instants routinely
 * differ by hours. An exact-map lookup silently matched almost nothing and
 * produced an empty grid that looked like a clean result.
 *
 * Matching to the nearest bar within a trading day is the correct tolerance
 * here: the sweep only needs the signal bar to locate the forward path, and a
 * same-day bar is the same session.
 */
const DAY_MS = 86_400_000;

const index = new Map<string, { byTs: Map<number, number>; times: number[] }>();
for (const [sym, bars] of candles) {
  const byTs = new Map<number, number>();
  for (let i = 0; i < bars.length; i++) byTs.set(bars[i]![T], i);
  index.set(sym, { byTs, times: bars.map((b) => b[T]) });
}

function findBar(
  entry: { byTs: Map<number, number>; times: number[] },
  ts: number,
): number | null {
  const exact = entry.byTs.get(ts);
  if (exact != null) return exact;
  const floored = entry.byTs.get(Math.floor(ts / 1000) * 1000);
  if (floored != null) return floored;
  // Binary search for the insertion point, then take the closer of the two
  // neighbours and reject anything outside a trading day.
  let lo = 0;
  let hi = entry.times.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = entry.times[mid]!;
    if (v === ts) return entry.byTs.get(v)!;
    if (v < ts) lo = mid + 1;
    else hi = mid - 1;
  }
  const candidates = [entry.times[hi], entry.times[lo]].filter((v): v is number => v != null);
  let bestT: number | null = null;
  let bestD = Infinity;
  for (const t of candidates) {
    const d = Math.abs(t - ts);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  if (bestT == null || bestD > DAY_MS) return null;
  return entry.byTs.get(bestT)!;
}

const results: Array<{ tm: number; hold: number; hit: number; exp: number; n: number }> = [];

// Why rows are dropped, so an empty grid is never mistaken for a clean result.
const skip = { noSymbol: 0, noIndex: 0, noBars: 0, badAtr: 0, badEntry: 0, riskTooWide: 0, badTarget: 0, noReplay: 0, ok: 0 };

for (const tm of TARGET_MULTIPLES) {
  for (const hold of HOLD_BARS) {
    let sum = 0;
    let n = 0;
    let hits = 0;
    for (const r of withBars) {
      const symIndex = index.get(r.symbol!);
      if (!symIndex) { skip.noSymbol++; continue; }
      const ts = typeof r.ts === "number" ? r.ts : Date.parse(String(r.ts));
      const i = findBar(symIndex, ts);
      if (i == null) { skip.noIndex++; continue; }
      const bars = candles.get(r.symbol!)!;
      const entry = bars[i]![C];
      const atr = r.features?.[ATR14_INDEX] ?? 0;
      if (!Number.isFinite(atr) || atr <= 0) { skip.badAtr++; continue; }
      if (!Number.isFinite(entry) || entry <= 0) { skip.badEntry++; continue; }
      const risk = ATR_RISK_MULT * atr;
      if (risk <= 0 || risk > entry * 0.08) { skip.riskTooWide++; continue; }
      const isBuy = (r.direction ?? "BUY").toUpperCase() !== "SELL";
      const stop = isBuy ? entry - risk : entry + risk;
      const target = isBuy ? entry + tm * risk : entry - tm * risk;
      if (target <= 0) { skip.badTarget++; continue; }
      const ret = replay(bars, i, isBuy, entry, stop, target, hold);
      if (ret == null) { skip.noReplay++; continue; }
      sum += ret;
      n += 1;
      if (ret > 0) hits += 1;
    }
    if (n > 0) {
      results.push({ tm, hold, hit: hits / n, exp: sum / n, n });
    }
  }
}

results.sort((a, b) => b.exp - a.exp);

console.log("Top 15 geometries by expectancy (% per trade, net of costs):");
console.log("  target  hold     n     hit%    expectancy");
for (const r of results.slice(0, 15)) {
  console.log(
    `  ${r.tm.toFixed(1).padStart(5)}R  ${String(r.hold).padStart(3)}  ${String(r.n).padStart(6)}  ` +
      `${(r.hit * 100).toFixed(1).padStart(5)}%  ${(r.exp >= 0 ? "+" : "") + r.exp.toFixed(4)}%`,
  );
}

const baseline = results.find((r) => r.tm === 2.0 && r.hold === 10);
const best = results[0];
console.log("");
console.log("skip reasons (last grid cell):", JSON.stringify(skip));
console.log("");
if (baseline) {
  console.log(`baseline 2.0R / 10 bars : ${baseline.exp.toFixed(4)}%  (hit ${(baseline.hit * 100).toFixed(1)}%)`);
}
if (best) {
  console.log(`best     ${best.tm.toFixed(1)}R / ${best.hold} bars : ${best.exp.toFixed(4)}%  (hit ${(best.hit * 100).toFixed(1)}%)`);
  if (baseline && best.exp > baseline.exp) {
    console.log(`improvement over baseline: ${((best.exp - baseline.exp) / Math.abs(baseline.exp) * 100).toFixed(0)}%`);
  }
  console.log("");
  console.log(best.exp > 0
    ? "Positive across the grid. Still an approximation - re-extract with the winning geometry to confirm."
    : "Best cell is still negative. Geometry alone does not fix this; the entry signal itself has no edge.");
}