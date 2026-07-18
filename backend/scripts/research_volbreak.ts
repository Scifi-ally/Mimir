/**
 * RESEARCH: Volatility-Contraction Breakout ("volbreak") — honest backtest.
 *
 * Family: N-bar range tightest (width percentile) NEAR the 60-bar high,
 * breakout close above the contraction box high on volume >= k * avg20,
 * stop at box midpoint/low (min 0.8 ATR14), R-multiple target, timeout exit.
 *
 * Honesty rules (mirrors backtest_setups.ts conventions):
 *   - NO LOOK-AHEAD: every indicator at bar i uses only bars <= i.
 *     Contraction is measured on the box ENDING AT i-1 (the bar before the
 *     breakout bar), breakout is bar i's close above that box high.
 *   - ENTRY: market-on-open of bar i+1 (stated & consistent). Signals on the
 *     last bar are discarded. Chase filter: if open(i+1) gaps > +3% above the
 *     signal close, or opens below the structural stop, trade is a NO_FILL.
 *   - FILLS: stop checked BEFORE target inside every bar (pessimistic),
 *     including the entry bar itself. 0.05% cost per side.
 *   - SPLIT: parameter sweep scores TRAIN (2026-01-13..2026-04-30) only.
 *     Validation (2026-05-01..2026-07-14) is computed once, for the chosen
 *     params, after selection.
 *
 * Adaptation for short history (122 bars/instrument): "60-bar high" and the
 * width-percentile window use min(60, bars available); warmup = 45 bars so the
 * train window actually contains signals. At warmup the 60-bar high equals the
 * all-history-in-sample high, which is stricter, never looser.
 *
 * Run: npx tsx backend/scripts/research_volbreak.ts [--sweep 0|1]
 */
import { db, candlesTable, pool } from "../db/src";
import { and, eq, asc } from "drizzle-orm";

const COST_RATE_PER_SIDE = 0.0005; // keep in sync with backtest_setups.ts
const WARMUP_BARS = 45;            // min history before a signal may fire
const HH_LOOKBACK = 60;            // position-in-range high lookback (capped by history)
const PCT_WINDOW = 60;             // width-percentile trailing window (capped by history)
const MIN_PCT_SAMPLES = 25;        // need this many trailing widths before percentile is meaningful
const GAP_CHASE_PCT = 0.03;        // skip entry if next open gaps >3% above signal close
const MIN_PRICE = 20;              // hygiene: no penny stocks
const MIN_TURNOVER = 10_000_000;   // hygiene: >= 1 crore avg daily traded value

const TRAIN_END = new Date("2026-04-30T23:59:59+05:30").getTime();
const VAL_START = new Date("2026-05-01T00:00:00+05:30").getTime();

interface Series {
  key: string;
  ts: number[];
  open: number[]; high: number[]; low: number[]; close: number[]; vol: number[];
  atr14: number[];              // Wilder ATR at bar i (bars <= i)
  avgVol20: number[];           // mean volume of bars i-20..i-1 (excludes bar i)
  hh: number[];                 // max high over last min(HH_LOOKBACK, i+1) bars incl. i
  boxHigh: Record<number, number[]>;  // per N: max high over bars i-N+1..i
  boxLow: Record<number, number[]>;   // per N: min low  over bars i-N+1..i
  widthPct: Record<number, number[]>; // per N: percentile rank of N-bar width at i vs trailing window (-1 = insufficient)
}

interface Params {
  N: number;          // contraction box length (bars)
  pct: number;        // width percentile threshold (0.10 = tightest decile)
  prox: number;       // close within this fraction of the 60-bar high
  volMult: number;    // breakout volume >= volMult * avgVol20
  stopMode: "mid" | "low";
  rMult: number;      // target = entry + rMult * risk
  holdBars: number;   // max bars in trade (entry bar counts as 1)
}

interface Trade {
  key: string;
  signalTs: number;
  outcome: "WIN" | "LOSS" | "TIMEOUT" | "NO_FILL";
  returnPct: number;  // net of costs; 0 for NO_FILL
}

const N_OPTIONS = [5, 7, 10];

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

// ── Precompute all per-instrument series once ────────────────────────────────
function buildSeries(key: string, rows: { ts: number; o: number; h: number; l: number; c: number; v: number }[]): Series {
  const n = rows.length;
  const ts = rows.map(r => r.ts);
  const open = rows.map(r => r.o), high = rows.map(r => r.h), low = rows.map(r => r.l);
  const close = rows.map(r => r.c), vol = rows.map(r => r.v);

  // Wilder ATR14
  const atr14 = new Array<number>(n).fill(NaN);
  {
    const trs: number[] = [];
    for (let i = 0; i < n; i++) {
      const tr = i === 0 ? high[i]! - low[i]!
        : Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!));
      trs.push(tr);
      if (i === 13) atr14[i] = trs.reduce((a, b) => a + b, 0) / 14;
      else if (i > 13) atr14[i] = (atr14[i - 1]! * 13 + tr) / 14;
    }
  }

  // avg volume of the PRIOR 20 bars (excludes current bar)
  const avgVol20 = new Array<number>(n).fill(NaN);
  let volSum = 0;
  for (let i = 0; i < n; i++) {
    if (i >= 20) avgVol20[i] = volSum / 20;
    volSum += vol[i]!;
    if (i >= 19) volSum -= vol[i - 19]!;
  }

  // rolling high over last min(HH_LOOKBACK, i+1) bars including i
  const hh = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - HH_LOOKBACK + 1); j <= i; j++) m = Math.max(m, high[j]!);
    hh[i] = m;
  }

  const boxHigh: Record<number, number[]> = {}, boxLow: Record<number, number[]> = {}, widthPct: Record<number, number[]> = {};
  for (const N of N_OPTIONS) {
    const bh = new Array<number>(n).fill(NaN), bl = new Array<number>(n).fill(NaN);
    const width = new Array<number>(n).fill(NaN);
    for (let i = N - 1; i < n; i++) {
      let mh = -Infinity, ml = Infinity;
      for (let j = i - N + 1; j <= i; j++) { mh = Math.max(mh, high[j]!); ml = Math.min(ml, low[j]!); }
      bh[i] = mh; bl[i] = ml;
      width[i] = (mh - ml) / close[i]!;
    }
    // percentile rank of width[i] among trailing min(PCT_WINDOW, available) widths (older bars, excluding i)
    const wp = new Array<number>(n).fill(-1);
    for (let i = N - 1; i < n; i++) {
      const from = Math.max(N - 1, i - PCT_WINDOW);
      const count = i - from;
      if (count < MIN_PCT_SAMPLES) continue;
      let below = 0;
      for (let j = from; j < i; j++) if (width[j]! < width[i]!) below++;
      wp[i] = below / count;
    }
    boxHigh[N] = bh; boxLow[N] = bl; widthPct[N] = wp;
  }

  return { key, ts, open, high, low, close, vol, atr14, avgVol20, hh, boxHigh, boxLow, widthPct };
}

// ── Signal scan + honest simulation for one parameter set ────────────────────
function runParams(all: Series[], p: Params): Trade[] {
  const trades: Trade[] = [];
  for (const s of all) {
    const n = s.ts.length;
    let blockedUntil = -1; // per-instrument cooldown: no new signal while prior trade window is open
    const bh = s.boxHigh[p.N]!, bl = s.boxLow[p.N]!, wp = s.widthPct[p.N]!;

    for (let i = WARMUP_BARS; i <= n - 2; i++) {  // need bar i+1 for entry; last-bar signals don't count
      if (i <= blockedUntil) continue;
      const c = s.close[i]!;

      // hygiene filters
      if (c < MIN_PRICE) continue;
      const av = s.avgVol20[i]!;
      if (!Number.isFinite(av) || av * c < MIN_TURNOVER) continue;
      const atr = s.atr14[i]!;
      if (!Number.isFinite(atr) || atr <= 0) continue;

      // 1. contraction: box ENDING AT i-1 is in the tightest pct of trailing widths
      const pctRank = wp[i - 1]!;
      if (pctRank < 0 || pctRank > p.pct) continue;

      // 2. proximity: signal close within prox of the 60-bar high
      if (c < s.hh[i]! * (1 - p.prox)) continue;

      // 3. breakout: close above the contraction box high (box excludes bar i)
      const boxH = bh[i - 1]!, boxL = bl[i - 1]!;
      if (!(c > boxH)) continue;

      // 4. volume expansion
      if (s.vol[i]! < p.volMult * av) continue;

      // ── simulate: entry at open of bar i+1 ──
      blockedUntil = i + p.holdBars; // reference-style cooldown regardless of outcome
      const entryIdx = i + 1;
      const entry = s.open[entryIdx]!;
      const structStop = p.stopMode === "mid" ? (boxH + boxL) / 2 : boxL;

      if (entry > c * (1 + GAP_CHASE_PCT) || entry <= structStop) {
        trades.push({ key: s.key, signalTs: s.ts[i]!, outcome: "NO_FILL", returnPct: 0 });
        continue;
      }

      const dist = Math.max(entry - structStop, 0.8 * atr);
      const stop = entry - dist;
      const target = entry + p.rMult * dist;

      let outcome: Trade["outcome"] = "TIMEOUT";
      let exit = NaN;
      const lastIdx = Math.min(entryIdx + p.holdBars - 1, n - 1);
      for (let j = entryIdx; j <= lastIdx; j++) {
        // stop checked BEFORE target — pessimistic on intrabar ambiguity;
        // if a bar gaps open below the stop, exit at the (worse) open price
        if (s.low[j]! <= stop) { outcome = "LOSS"; exit = Math.min(stop, s.open[j]!); break; }
        if (s.high[j]! >= target) { outcome = "WIN"; exit = target; break; }
      }
      if (outcome === "TIMEOUT") exit = s.close[lastIdx]!;

      const gross = (exit - entry) / entry;
      trades.push({ key: s.key, signalTs: s.ts[i]!, outcome, returnPct: (gross - 2 * COST_RATE_PER_SIDE) * 100 });
    }
  }
  return trades;
}

// ── Reporting helpers ────────────────────────────────────────────────────────
interface Stats {
  signals: number; fills: number; noFills: number;
  wins: number; losses: number; timeouts: number;
  winRatePct: number | null; expectancyPct: number | null;
  sePct: number | null; maxConsecLosses: number;
}

function stats(trades: Trade[]): Stats {
  const signals = trades.length;
  const filled = trades.filter(t => t.outcome !== "NO_FILL");
  const wins = filled.filter(t => t.outcome === "WIN").length;
  const losses = filled.filter(t => t.outcome === "LOSS").length;
  const timeouts = filled.filter(t => t.outcome === "TIMEOUT").length;
  const rets = filled.map(t => t.returnPct);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
  let se: number | null = null;
  if (mean != null && rets.length > 1) {
    const varr = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
    se = Math.sqrt(varr / rets.length);
  }
  // max consecutive losses on filled trades in chronological (signal ts) order
  let maxStreak = 0, streak = 0;
  for (const t of [...filled].sort((a, b) => a.signalTs - b.signalTs || (a.key < b.key ? -1 : 1))) {
    if (t.outcome === "LOSS") { streak++; maxStreak = Math.max(maxStreak, streak); }
    else streak = 0;
  }
  return {
    signals, fills: filled.length, noFills: signals - filled.length,
    wins, losses, timeouts,
    winRatePct: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
    expectancyPct: mean != null ? Math.round(mean * 1000) / 1000 : null,
    sePct: se != null ? Math.round(se * 1000) / 1000 : null,
    maxConsecLosses: maxStreak,
  };
}

function monthly(trades: Trade[]) {
  const byMonth = new Map<string, Trade[]>();
  for (const t of trades) {
    const d = new Date(t.signalTs);
    // IST month of the signal bar
    const m = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(d);
    const arr = byMonth.get(m) ?? [];
    arr.push(t); byMonth.set(m, arr);
  }
  return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, ts]) => {
    const s = stats(ts);
    return { month, signals: s.signals, fills: s.fills, wins: s.wins, losses: s.losses,
      timeouts: s.timeouts, winRatePct: s.winRatePct, expectancyPct: s.expectancyPct };
  });
}

function printWindow(label: string, trades: Trade[]) {
  const s = stats(trades);
  console.log(`\n── ${label} ──`);
  console.table([{
    signals: s.signals, fills: s.fills, noFills: s.noFills,
    wins: s.wins, losses: s.losses, timeouts: s.timeouts,
    winRatePct: s.winRatePct, expectancyPct: s.expectancyPct,
    stdErrPct: s.sePct, maxConsecLosses: s.maxConsecLosses,
  }]);
  console.table(monthly(trades));
  if (s.fills < 40) console.log(`⚠ ${label}: only ${s.fills} filled trades — statistically weak.`);
}

/**
 * Market-drift baseline: mean forward `hold`-bar return (open i+1 → close,
 * net of costs) over ALL eligible bars, no signal filter. If the strategy's
 * expectancy is not above this, the "edge" is just market beta.
 */
function baseline(all: Series[], holdBars: number) {
  const byWindow = { train: [] as number[], val: [] as number[] };
  for (const s of all) {
    const n = s.ts.length;
    for (let i = WARMUP_BARS; i <= n - 2; i += holdBars) { // non-overlapping, same cadence as trades
      const c = s.close[i]!;
      if (c < MIN_PRICE) continue;
      const av = s.avgVol20[i]!;
      if (!Number.isFinite(av) || av * c < MIN_TURNOVER) continue;
      const entry = s.open[i + 1]!;
      const lastIdx = Math.min(i + holdBars, n - 1);
      const ret = ((s.close[lastIdx]! - entry) / entry - 2 * COST_RATE_PER_SIDE) * 100;
      if (s.ts[i]! <= TRAIN_END) byWindow.train.push(ret);
      else if (s.ts[i]! >= VAL_START) byWindow.val.push(ret);
    }
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  console.log(`\nMarket-drift baseline (all eligible bars, ${holdBars}-bar hold, net of costs):`);
  console.log(`  TRAIN: ${mean(byWindow.train).toFixed(3)}%/trade (n=${byWindow.train.length})`);
  console.log(`  VAL:   ${mean(byWindow.val).toFixed(3)}%/trade (n=${byWindow.val.length})`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const doSweep = argNum("sweep", 1) !== 0;
  console.log("Loading daily candles…");
  const rows = await db
    .select({ instrumentKey: candlesTable.instrumentKey, timestamp: candlesTable.timestamp,
      open: candlesTable.open, high: candlesTable.high, low: candlesTable.low,
      close: candlesTable.close, volume: candlesTable.volume })
    .from(candlesTable)
    .where(eq(candlesTable.interval, "day"))
    .orderBy(asc(candlesTable.instrumentKey), asc(candlesTable.timestamp));

  const byKey = new Map<string, { ts: number; o: number; h: number; l: number; c: number; v: number }[]>();
  for (const r of rows) {
    const arr = byKey.get(r.instrumentKey) ?? [];
    arr.push({ ts: r.timestamp.getTime(), o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume });
    byKey.set(r.instrumentKey, arr);
  }

  console.log(`Precomputing series for ${byKey.size} instruments…`);
  const all: Series[] = [];
  for (const [key, arr] of byKey) {
    if (arr.length < WARMUP_BARS + 5) continue;
    all.push(buildSeries(key, arr));
  }
  console.log(`${all.length} instruments have >= ${WARMUP_BARS + 5} bars.\n`);

  // ── Parameter sweep, scored on TRAIN only ──────────────────────────────────
  const grid: Params[] = [];
  for (const N of N_OPTIONS)
    for (const pct of [0.10, 0.20])
      for (const prox of [0.02, 0.03, 0.05])
        for (const volMult of [1.3, 1.5, 2.0])
          for (const stopMode of ["mid", "low"] as const)
            for (const rMult of [1.5, 2, 3])
              for (const holdBars of [10, 15])
                grid.push({ N, pct, prox, volMult, stopMode, rMult, holdBars });

  let chosen: Params = { N: 7, pct: 0.20, prox: 0.03, volMult: 1.5, stopMode: "mid", rMult: 2, holdBars: 15 };

  if (doSweep) {
    console.log(`Sweeping ${grid.length} parameter combos on TRAIN window only…`);
    const MIN_TRAIN_FILLS = 80;
    const scored: { p: Params; exp: number; lcb: number; fills: number; winRate: number | null }[] = [];
    const allExp: number[] = [];
    for (const p of grid) {
      const trainTrades = runParams(all, p).filter(t => t.signalTs <= TRAIN_END);
      const s = stats(trainTrades);
      if (s.expectancyPct != null) allExp.push(s.expectancyPct);
      if (s.fills < MIN_TRAIN_FILLS || s.expectancyPct == null || s.sePct == null) continue;
      // rank by lower confidence bound (mean − 1.5·SE): rewards edge AND sample size
      scored.push({ p, exp: s.expectancyPct, lcb: s.expectancyPct - 1.5 * s.sePct, fills: s.fills, winRate: s.winRatePct });
    }
    scored.sort((a, b) => b.lcb - a.lcb);
    allExp.sort((a, b) => a - b);
    const median = allExp.length ? allExp[Math.floor(allExp.length / 2)]! : NaN;
    console.log(`Family sanity: median TRAIN expectancy across all ${allExp.length} combos = ${median?.toFixed(3)}%`);
    console.log(`Combos with >= ${MIN_TRAIN_FILLS} train fills: ${scored.length}. Top 12 by LCB(mean − 1.5·SE):`);
    console.table(scored.slice(0, 12).map(({ p, exp, lcb, fills, winRate }) => ({
      N: p.N, pct: p.pct, prox: p.prox, vol: p.volMult, stop: p.stopMode, R: p.rMult, hold: p.holdBars,
      trainFills: fills, trainWinRate: winRate, trainExp: exp, lcb: Math.round(lcb * 1000) / 1000,
    })));
    if (scored.length > 0) chosen = scored[0]!.p;
    else console.log("No combo met the minimum train sample — falling back to family defaults.");
  }

  // ── Final report: chosen params on train AND untouched validation ──────────
  console.log(`\nCHOSEN PARAMS: N=${chosen.N} widthPct<=${chosen.pct} prox<=${(chosen.prox * 100).toFixed(0)}% ` +
    `vol>=${chosen.volMult}x stop=${chosen.stopMode} target=${chosen.rMult}R hold=${chosen.holdBars} bars`);
  console.log(`Entry: next-bar open. Costs: ${COST_RATE_PER_SIDE * 100}%/side. Stop-before-target intrabar.`);

  const trades = runParams(all, chosen);
  const train = trades.filter(t => t.signalTs <= TRAIN_END);
  const val = trades.filter(t => t.signalTs >= VAL_START);
  printWindow("TRAIN 2026-01-13..2026-04-30 (tuned on this)", train);
  printWindow("VALIDATION 2026-05-01..2026-07-14 (untouched)", val);

  baseline(all, chosen.holdBars);

  // Pre-registered family defaults (NOT tuned; reported regardless of outcome
  // as an overfitting control for the sweep-selected combo above).
  const dflt: Params = { N: 7, pct: 0.15, prox: 0.03, volMult: 1.5, stopMode: "mid", rMult: 2, holdBars: 15 };
  console.log(`\nFAMILY-DEFAULT CONTROL (untuned): N=${dflt.N} widthPct<=${dflt.pct} prox<=3% vol>=1.5x stop=mid 2R hold=15`);
  const dTrades = runParams(all, dflt);
  printWindow("DEFAULT / TRAIN", dTrades.filter(t => t.signalTs <= TRAIN_END));
  printWindow("DEFAULT / VALIDATION", dTrades.filter(t => t.signalTs >= VAL_START));

  await pool.end();
}

main().catch((err) => { console.error("Research backtest failed:", err); process.exit(1); });
