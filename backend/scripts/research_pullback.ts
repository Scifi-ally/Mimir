/**
 * RESEARCH SCRIPT — Pullback-to-trend continuation (key: pullback)
 *
 * Strategy family: strong uptrend, price recently made a 40-bar high, enter on a
 * controlled pullback into the EMA20/EMA50 zone on contracting volume, trigger on
 * a reversal bar (close above prior bar's high), stop under the pullback low with
 * a minimum distance of 0.8 ATR, target = R multiple of risk, timeout exit at close.
 *
 * DATA CAVEAT: the DB holds only ~117 daily bars per instrument (2026-01-13..2026-07-14),
 * so EMA200 cannot be computed. Trend-strength proxy used instead:
 *   EMA20 > EMA50, close > EMA50, and (optionally, tuned on TRAIN) EMA50 rising
 *   over the last 10 bars. This is stated honestly in the report.
 *
 * NO LOOK-AHEAD: every indicator at bar i uses only bars <= i. Entry fills at the
 * OPEN of bar i+1 (stated, consistent). Signals on the last bar are discarded.
 *
 * HONEST FILLS (mirrors backtest_setups.ts):
 *   - gap guard: if next open gaps > maxGapPct above signal close -> NO_FILL
 *   - if next open is already at/below stop -> immediate LOSS exited at that open
 *   - within a bar, stop is checked BEFORE target (pessimistic on ambiguity)
 *   - 0.05% cost per side (0.1% round trip), timeouts exit at last close in window
 *
 * TRAIN/VALIDATION: all tuning done via `--sweep` which scores TRAIN ONLY
 * (signal dates 2026-01-13..2026-04-30). The default run reports the frozen
 * CHOSEN params on BOTH train and the untouched validation window
 * (2026-05-01..2026-07-14).
 *
 * Run: npx tsx backend/scripts/research_pullback.ts [--sweep]
 */
import { db, candlesTable } from "../db/src";
import { and, eq, asc } from "drizzle-orm";

const COST_RATE_PER_SIDE = 0.0005; // keep in sync with backtest_setups.ts
const WARMUP_BARS = 55;            // EMA50 seed + 40-bar-high lookback
const MAX_GAP_PCT = 0.015;         // skip fills gapping >1.5% above signal close
const MAX_RISK_PCT = 0.08;         // skip setups risking >8% of entry (mirrors prod)
const TRAIN_END = "2026-04-30";    // signal-date split, inclusive
const MIN_TURNOVER = 10_000_000;   // >=1 crore INR avg 20d turnover (fixed a priori, not tuned)
const MIN_PRICE = 20;              // penny-stock guard (fixed a priori, not tuned)

interface Params {
  volContraction: number; // pullback-bars avg volume / 20d avg must be < this (99 = off)
  maxDepthATR: number;    // (recent 40-bar high - pullback low)/ATR must be <= this (99 = off)
  requireSlope: boolean;  // EMA50[i] > EMA50[i-10] (trend-strength proxy for EMA200 filter)
  highWithin: number;     // 40-bar high must have been made within last N bars
  rMultiple: number;      // target = entry + R * risk
  holdBars: number;       // timeout window
}

// Frozen after TRAIN-only sweep (see --sweep). Do not tune on validation.
const CHOSEN: Params = {
  volContraction: 1.0,
  maxDepthATR: 99,
  requireSlope: true,
  highWithin: 10,
  rMultiple: 2,
  holdBars: 15,
};

interface Trade {
  instrumentKey: string;
  signalDate: string; // YYYY-MM-DD (UTC date of signal bar)
  outcome: "WIN" | "LOSS" | "NO_FILL" | "TIMEOUT";
  returnPct: number;  // net of costs; 0 for NO_FILL
}

interface Series {
  instrumentKey: string;
  dates: string[];
  open: number[]; high: number[]; low: number[]; close: number[]; volume: number[];
  ema20: number[]; ema50: number[]; atr14: number[]; volSma20: number[];
  high40: number[];      // rolling max(high) over last 40 bars incl. current
  high40Age: number[];   // bars since that 40-bar high was set (0 = today)
}

function emaSeries(values: number[], period: number): number[] {
  // Matches computeEMA in src/analysis/technical.ts: SMA seed at index period-1,
  // raw values before that (bars < period-1 are never used thanks to WARMUP_BARS).
  const k = 2 / (period + 1);
  const out: number[] = new Array(values.length);
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out[i] = values[i]!; continue; }
    if (i === period - 1) {
      let s = 0;
      for (let j = 0; j < period; j++) s += values[j]!;
      prev = s / period;
    } else {
      prev = values[i]! * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function atrSeries(high: number[], low: number[], close: number[], period = 14): number[] {
  // Wilder ATR, recursive from the start of history — at bar i uses only bars <= i.
  const n = high.length;
  const out: number[] = new Array(n).fill(0);
  if (n < 2) return out;
  let atr = 0;
  let count = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!));
    if (count < period) {
      atr = (atr * count + tr) / (count + 1);
      count++;
    } else {
      atr = (atr * (period - 1) + tr) / period;
    }
    out[i] = atr;
  }
  return out;
}

function buildSeries(instrumentKey: string, rows: { timestamp: Date; open: number; high: number; low: number; close: number; volume: number }[]): Series {
  const n = rows.length;
  const dates = rows.map((r) => r.timestamp.toISOString().slice(0, 10));
  const open = rows.map((r) => r.open), high = rows.map((r) => r.high);
  const low = rows.map((r) => r.low), close = rows.map((r) => r.close);
  const volume = rows.map((r) => r.volume);

  const ema20 = emaSeries(close, 20);
  const ema50 = emaSeries(close, 50);
  const atr14 = atrSeries(high, low, close, 14);

  const volSma20: number[] = new Array(n).fill(0);
  let vSum = 0;
  for (let i = 0; i < n; i++) {
    vSum += volume[i]!;
    if (i >= 20) vSum -= volume[i - 20]!;
    volSma20[i] = vSum / Math.min(i + 1, 20);
  }

  const high40: number[] = new Array(n).fill(0);
  const high40Age: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - 39);
    let hi = -Infinity, hiIdx = from;
    for (let j = from; j <= i; j++) {
      if (high[j]! >= hi) { hi = high[j]!; hiIdx = j; } // >= keeps most recent equal high
    }
    high40[i] = hi;
    high40Age[i] = i - hiIdx;
  }

  return { instrumentKey, dates, open, high, low, close, volume, ema20, ema50, atr14, volSma20, high40, high40Age };
}

/** Detect signals and walk forward with honest fills. Entry = OPEN of bar i+1. */
function runStrategy(series: Series[], p: Params): Trade[] {
  const trades: Trade[] = [];

  for (const s of series) {
    const n = s.dates.length;
    let lastSignalIdx = -Infinity;

    for (let i = WARMUP_BARS; i < n - 1; i++) { // n-1: last-bar signals discarded
      if (i - lastSignalIdx < p.holdBars) continue; // still "in" prior trade

      const c = s.close[i]!, atr = s.atr14[i]!;
      if (c < MIN_PRICE || atr <= 0) continue;
      if (s.close[i]! * s.volSma20[i]! < MIN_TURNOVER) continue;

      // ── Trend filter (EMA200 proxy documented in header) ──
      if (!(s.ema20[i]! > s.ema50[i]! && c > s.ema50[i]!)) continue;
      if (p.requireSlope && !(s.ema50[i]! > s.ema50[i - 10]!)) continue;
      if (s.high40Age[i]! > p.highWithin) continue; // 40-bar high made recently

      // ── Controlled pullback into EMA20/EMA50 zone over the last 4 bars ──
      let touched = false;
      let pullbackLow = Infinity;
      for (let j = Math.max(0, i - 3); j <= i; j++) {
        if (s.low[j]! <= s.ema20[j]!) touched = true;
        if (s.low[j]! < pullbackLow) pullbackLow = s.low[j]!;
      }
      if (!touched) continue;
      if (pullbackLow < s.ema50[i]! - 0.25 * atr) continue; // broke the zone = not controlled
      if ((s.high40[i]! - pullbackLow) / atr > p.maxDepthATR) continue;

      // Contracting volume on the pullback bars
      const pbFrom = Math.max(0, i - 3);
      let pbVol = 0;
      for (let j = pbFrom; j <= i; j++) pbVol += s.volume[j]!;
      pbVol /= i - pbFrom + 1;
      if (s.volSma20[i]! > 0 && pbVol / s.volSma20[i]! >= p.volContraction) continue;

      // ── Reversal trigger bar ──
      if (!(c > s.high[i - 1]! && c > s.open[i]! && c > s.ema20[i]!)) continue;

      lastSignalIdx = i;

      // ── Simulate: fill at next bar's open ──
      const stop = Math.min(pullbackLow - 0.1 * atr, c - 0.8 * atr); // min 0.8 ATR under structure
      const entryBar = i + 1;
      const fill = s.open[entryBar]!;

      if (fill > c * (1 + MAX_GAP_PCT)) {
        trades.push({ instrumentKey: s.instrumentKey, signalDate: s.dates[i]!, outcome: "NO_FILL", returnPct: 0 });
        continue;
      }
      if (fill <= stop) {
        // Opened at/below the stop: stop order triggers immediately — in and out
        // at the open, gross 0, pay round-trip costs. Counted as a LOSS.
        const net = (0 - 2 * COST_RATE_PER_SIDE) * 100;
        trades.push({ instrumentKey: s.instrumentKey, signalDate: s.dates[i]!, outcome: "LOSS", returnPct: net });
        continue;
      }
      const risk = fill - stop;
      if (risk <= 0 || risk > fill * MAX_RISK_PCT) {
        trades.push({ instrumentKey: s.instrumentKey, signalDate: s.dates[i]!, outcome: "NO_FILL", returnPct: 0 });
        continue;
      }
      const target = fill + p.rMultiple * risk;

      let done = false;
      const lastIdx = Math.min(i + p.holdBars, n - 1);
      for (let b = entryBar; b <= lastIdx; b++) {
        // Stop BEFORE target when both are inside the same bar — pessimistic.
        if (s.low[b]! <= stop) {
          const exit = b === entryBar && s.open[b]! < stop ? s.open[b]! : stop;
          const net = ((exit - fill) / fill - 2 * COST_RATE_PER_SIDE) * 100;
          trades.push({ instrumentKey: s.instrumentKey, signalDate: s.dates[i]!, outcome: "LOSS", returnPct: net });
          done = true;
          break;
        }
        if (s.high[b]! >= target) {
          const exit = b === entryBar && s.open[b]! > target ? s.open[b]! : target;
          const net = ((exit - fill) / fill - 2 * COST_RATE_PER_SIDE) * 100;
          trades.push({ instrumentKey: s.instrumentKey, signalDate: s.dates[i]!, outcome: "WIN", returnPct: net });
          done = true;
          break;
        }
      }
      if (!done) {
        const exit = s.close[lastIdx]!;
        const net = ((exit - fill) / fill - 2 * COST_RATE_PER_SIDE) * 100;
        trades.push({ instrumentKey: s.instrumentKey, signalDate: s.dates[i]!, outcome: "TIMEOUT", returnPct: net });
      }
    }
  }
  return trades;
}

interface Stats {
  signals: number; fills: number; wins: number; losses: number; timeouts: number; noFills: number;
  winRatePct: number | null; expectancyPct: number | null; maxConsecLosses: number;
}

function computeStats(trades: Trade[]): Stats {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
  const noFills = trades.filter((t) => t.outcome === "NO_FILL").length;
  const filled = trades.filter((t) => t.outcome !== "NO_FILL");
  const expectancy = filled.length ? filled.reduce((a, t) => a + t.returnPct, 0) / filled.length : null;

  // Max consecutive losing trades in chronological (signal-date) order.
  let maxRun = 0, run = 0;
  for (const t of [...filled].sort((a, b) => a.signalDate.localeCompare(b.signalDate))) {
    if (t.returnPct < 0) { run++; if (run > maxRun) maxRun = run; }
    else run = 0;
  }

  return {
    signals: trades.length,
    fills: filled.length,
    wins, losses, timeouts, noFills,
    winRatePct: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
    expectancyPct: expectancy != null ? Math.round(expectancy * 1000) / 1000 : null,
    maxConsecLosses: maxRun,
  };
}

function monthlyBreakdown(trades: Trade[]) {
  const byMonth = new Map<string, Trade[]>();
  for (const t of trades) {
    const m = t.signalDate.slice(0, 7);
    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(t);
  }
  return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, ts]) => {
    const st = computeStats(ts);
    return { month, signals: st.signals, fills: st.fills, wins: st.wins, losses: st.losses, timeouts: st.timeouts, winRatePct: st.winRatePct, expectancyPct: st.expectancyPct };
  });
}

async function main() {
  const sweep = process.argv.includes("--sweep");

  console.log("Loading daily candles...");
  const rows = await db
    .select({
      instrumentKey: candlesTable.instrumentKey,
      timestamp: candlesTable.timestamp,
      open: candlesTable.open, high: candlesTable.high,
      low: candlesTable.low, close: candlesTable.close,
      volume: candlesTable.volume,
    })
    .from(candlesTable)
    .where(and(eq(candlesTable.interval, "day")))
    .orderBy(asc(candlesTable.instrumentKey), asc(candlesTable.timestamp));

  const byInstrument = new Map<string, typeof rows>();
  for (const r of rows) {
    (byInstrument.get(r.instrumentKey) ?? byInstrument.set(r.instrumentKey, []).get(r.instrumentKey)!).push(r);
  }

  const series: Series[] = [];
  for (const [key, rs] of byInstrument) {
    if (rs.length < WARMUP_BARS + 5) continue;
    series.push(buildSeries(key, rs));
  }
  console.log(`Loaded ${rows.length} bars across ${series.length} usable instruments (of ${byInstrument.size}).\n`);

  const isTrain = (t: Trade) => t.signalDate <= TRAIN_END;

  if (sweep) {
    // ── TRAIN-ONLY parameter sweep. Validation window is never touched here. ──
    console.log(`Parameter sweep on TRAIN window only (signals <= ${TRAIN_END}):\n`);
    const grid: Params[] = [];
    for (const volContraction of [0.85, 1.0, 99]) {
      for (const maxDepthATR of [5, 99]) {
        for (const requireSlope of [true, false]) {
          for (const rMultiple of [1.5, 2, 2.5]) {
            for (const holdBars of [10, 15, 20]) {
              grid.push({ volContraction, maxDepthATR, requireSlope, highWithin: 10, rMultiple, holdBars });
            }
          }
        }
      }
    }
    const out = grid.map((p) => {
      const st = computeStats(runStrategy(series, p).filter(isTrain));
      return {
        vol: p.volContraction, depth: p.maxDepthATR, slope: p.requireSlope, R: p.rMultiple, hold: p.holdBars,
        signals: st.signals, fills: st.fills, winRatePct: st.winRatePct, expPct: st.expectancyPct, maxLossRun: st.maxConsecLosses,
      };
    }).sort((a, b) => (b.expPct ?? -99) - (a.expPct ?? -99));
    console.table(out);
    console.log("\nPick params from this table, freeze them in CHOSEN, then run without --sweep.");
    process.exit(0);
  }

  // ── Final run: frozen params, both windows reported ──
  console.log("CHOSEN params (frozen after train-only sweep):", CHOSEN);
  console.log(`Entry fills at the OPEN of the bar after the signal. Costs ${COST_RATE_PER_SIDE * 100}%/side.\n`);

  const trades = runStrategy(series, CHOSEN);
  const train = trades.filter(isTrain);
  const valid = trades.filter((t) => !isTrain(t));

  console.log(`== TRAIN (2026-01-13 .. ${TRAIN_END}) ==`);
  console.table([computeStats(train)]);
  console.table(monthlyBreakdown(train));

  console.log(`\n== VALIDATION (2026-05-01 .. 2026-07-14, untouched during tuning) ==`);
  console.table([computeStats(valid)]);
  console.table(monthlyBreakdown(valid));

  const vs = computeStats(valid);
  if ((vs.wins + vs.losses + vs.timeouts) < 40) {
    console.log("\n⚠ Fewer than 40 filled validation trades — statistically weak, treat with caution.");
  }
  if ((vs.expectancyPct ?? 0) <= 0) {
    console.log("⚠ Validation expectancy is non-positive: the tuned edge did NOT survive out-of-sample.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Research backtest failed:", err);
  process.exit(1);
});
