/**
 * RESEARCH: short-term mean reversion in uptrends (family key: meanrev).
 *
 * Buy sharp 2-4 day pullbacks (RSI(2) oversold / consecutive down closes) in
 * liquid stocks trading above a medium-length EMA; exit on snap-back
 * (close > EMA5 or RSI(2) > 70), ATR stop, N-bar timeout.
 *
 * NOTE: the DB holds only ~122 daily bars per instrument (2026-01-14..2026-07-15),
 * so the classic EMA200 trend filter is impossible. The longest affordable
 * EMAs (20/30/40) are swept as the trend filter instead — stated deviation.
 *
 * Honesty rules (mirrors backtest_setups.ts):
 *   - all indicators at bar i use only bars <= i; signals never on the last bar
 *   - entry is a LIMIT at the signal bar's close, good for the NEXT bar only:
 *     fills iff bar i+1 low <= entry, credited AT the entry price (pessimistic —
 *     a gap-down open would fill cheaper in reality); untouched => NO_FILL
 *   - intrabar ambiguity: stop checked BEFORE the snap-back exit on every bar
 *     including the fill bar
 *   - snap-back exit fires at that bar's CLOSE (condition uses that same close)
 *   - timeout: exit at close of bar fillIdx + holdBars
 *   - 0.05% cost per side on every filled trade
 *   - train/validation split BY SIGNAL DATE: tune on <= 2026-04-30, report
 *     final numbers on >= 2026-05-01 (late-April trades may resolve in early May
 *     — standard walk-forward, noted)
 *
 * Run: npx tsx backend/scripts/research_meanrev.ts            (final config, both windows)
 *      npx tsx backend/scripts/research_meanrev.ts --sweep    (grid search, TRAIN ONLY)
 */
import { db, candlesTable, pool } from "../db/src";
import { and, eq, asc } from "drizzle-orm";

const COST_RATE_PER_SIDE = 0.0005; // keep in sync with backtest_setups.ts
const WARMUP_BARS = 41; // longest EMA (40) + 1; signals never earlier
const MIN_TURNOVER = 5e7; // 20-bar avg close*volume >= 5 crore INR
const MIN_PRICE = 20; // no penny stocks
const TRAIN_END = new Date("2026-04-30T23:59:59+05:30").getTime();

// ── FINAL CONFIG (chosen on TRAIN only via --sweep; see sweep output) ────────
const FINAL = {
  trigger: "rsi10" as Trigger,    // RSI(2) < 10 at signal close
  trendEma: 40 as 20 | 30 | 40,   // close > EMA40
  stopK: 2.0,                     // stop = entry - 2.0 * ATR(14)
  holdBars: 10,                   // timeout bars after fill
};

type Trigger = "rsi5" | "rsi10" | "dn3" | "rsi10dn2";

interface Series {
  key: string;
  ts: number[];
  open: number[]; high: number[]; low: number[]; close: number[];
  ema5: number[]; ema20: number[]; ema30: number[]; ema40: number[];
  rsi2: number[]; atr14: number[]; downStreak: number[]; turnover20: number[];
}

interface Config { trigger: Trigger; trendEma: 20 | 30 | 40; stopK: number; holdBars: number }

interface Trade {
  key: string;
  signalTs: number;
  outcome: "WIN" | "LOSS" | "NO_FILL" | "TIMEOUT";
  exitReason: "stop" | "snapback" | "timeout" | "none";
  returnPct: number; // net of costs, 0 for NO_FILL
}

// ── Causal indicators: value at index i uses bars <= i only ──────────────────
function emaSeries(close: number[], period: number): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  if (close.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += close[i]!;
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < close.length; i++) out[i] = close[i]! * k + out[i - 1]! * (1 - k);
  return out;
}

function rsiSeries(close: number[], period: number): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  if (close.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = close[i]! - close[i - 1]!;
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < close.length; i++) {
    const d = close[i]! - close[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function atrSeries(high: number[], low: number[], close: number[], period: number): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  if (close.length <= period) return out;
  const tr = (i: number) =>
    Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!));
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr(i);
  out[period] = sum / period;
  for (let i = period + 1; i < close.length; i++) out[i] = (out[i - 1]! * (period - 1) + tr(i)) / period;
  return out;
}

function buildSeries(key: string, rows: { ts: number; open: number; high: number; low: number; close: number; volume: number }[]): Series {
  const n = rows.length;
  const ts = rows.map((r) => r.ts);
  const open = rows.map((r) => r.open), high = rows.map((r) => r.high);
  const low = rows.map((r) => r.low), close = rows.map((r) => r.close);
  const downStreak = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) downStreak[i] = close[i]! < close[i - 1]! ? downStreak[i - 1]! + 1 : 0;
  const turnover20 = new Array<number>(n).fill(NaN);
  let tSum = 0;
  for (let i = 0; i < n; i++) {
    tSum += close[i]! * rows[i]!.volume;
    if (i >= 20) tSum -= close[i - 20]! * rows[i - 20]!.volume;
    if (i >= 19) turnover20[i] = tSum / 20;
  }
  return {
    key, ts, open, high, low, close,
    ema5: emaSeries(close, 5), ema20: emaSeries(close, 20),
    ema30: emaSeries(close, 30), ema40: emaSeries(close, 40),
    rsi2: rsiSeries(close, 2), atr14: atrSeries(high, low, close, 14),
    downStreak, turnover20,
  };
}

function triggerFires(s: Series, i: number, trigger: Trigger): boolean {
  const rsi = s.rsi2[i]!, dn = s.downStreak[i]!;
  switch (trigger) {
    case "rsi5": return rsi < 5;
    case "rsi10": return rsi < 10;
    case "dn3": return dn >= 3;
    case "rsi10dn2": return rsi < 10 && dn >= 2;
  }
}

/** Walk forward from signal bar i. Mirrors backtest_setups.simulate pessimism. */
function simulate(s: Series, i: number, cfg: Config): Trade {
  const entry = s.close[i]!;
  const stop = entry - cfg.stopK * s.atr14[i]!;
  const base: Omit<Trade, "outcome" | "exitReason" | "returnPct"> = { key: s.key, signalTs: s.ts[i]! };
  const net = (gross: number) => (gross - 2 * COST_RATE_PER_SIDE) * 100;

  // Limit order good for next bar only
  const fillIdx = i + 1;
  if (s.low[fillIdx]! > entry) return { ...base, outcome: "NO_FILL", exitReason: "none", returnPct: 0 };

  const lastIdx = Math.min(fillIdx + cfg.holdBars, s.close.length - 1);
  for (let j = fillIdx; j <= lastIdx; j++) {
    // Stop checked BEFORE snap-back — pessimistic on intrabar ambiguity.
    // Credited at the stop price even if the bar gapped below it (mirrors
    // backtest_setups; entry credited at limit price makes the pair pessimistic).
    if (s.low[j]! <= stop) {
      return { ...base, outcome: "LOSS", exitReason: "stop", returnPct: net((stop - entry) / entry) };
    }
    // Snap-back: condition on bar j's close, executed at that same close (MOC)
    if (s.close[j]! > s.ema5[j]! || s.rsi2[j]! > 70) {
      const gross = (s.close[j]! - entry) / entry;
      const r = net(gross);
      return { ...base, outcome: r > 0 ? "WIN" : "LOSS", exitReason: "snapback", returnPct: r };
    }
  }
  const gross = (s.close[lastIdx]! - entry) / entry;
  return { ...base, outcome: "TIMEOUT", exitReason: "timeout", returnPct: net(gross) };
}

function runConfig(all: Series[], cfg: Config): Trade[] {
  const trades: Trade[] = [];
  for (const s of all) {
    const n = s.close.length;
    let busyUntil = -1; // bar index; one open trade per instrument
    // need fill bar + full hold window inside data; never signal on the last bar
    for (let i = WARMUP_BARS; i < n - 1 - cfg.holdBars; i++) {
      if (i <= busyUntil) continue;
      const emaT = cfg.trendEma === 20 ? s.ema20[i]! : cfg.trendEma === 30 ? s.ema30[i]! : s.ema40[i]!;
      if (!Number.isFinite(emaT) || !Number.isFinite(s.atr14[i]!) || !Number.isFinite(s.rsi2[i]!)) continue;
      if (s.turnover20[i]! < MIN_TURNOVER || s.close[i]! < MIN_PRICE) continue;
      if (s.close[i]! <= emaT) continue; // uptrend filter
      if (!triggerFires(s, i, cfg.trigger)) continue;
      const t = simulate(s, i, cfg);
      trades.push(t);
      busyUntil = t.outcome === "NO_FILL" ? i + 1 : i + 1 + cfg.holdBars;
    }
  }
  return trades;
}

interface Stats {
  signals: number; fills: number; wins: number; losses: number; timeouts: number; noFills: number;
  winRatePct: number | null; expectancyPct: number | null; maxConsecLosses: number;
}

function stats(trades: Trade[]): Stats {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
  const noFills = trades.filter((t) => t.outcome === "NO_FILL").length;
  const filled = trades.filter((t) => t.outcome !== "NO_FILL");
  const exp = filled.length ? filled.reduce((a, t) => a + t.returnPct, 0) / filled.length : null;
  // losing streak over filled trades in signal-date order (portfolio approximation);
  // a "loss" here = net return < 0, including negative timeouts
  const ordered = [...filled].sort((a, b) => a.signalTs - b.signalTs || (a.key < b.key ? -1 : 1));
  let maxStreak = 0, cur = 0;
  for (const t of ordered) {
    cur = t.returnPct < 0 ? cur + 1 : 0;
    maxStreak = Math.max(maxStreak, cur);
  }
  return {
    signals: trades.length, fills: filled.length, wins, losses, timeouts, noFills,
    winRatePct: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
    expectancyPct: exp == null ? null : Math.round(exp * 1000) / 1000,
    maxConsecLosses: maxStreak,
  };
}

function monthly(trades: Trade[]) {
  const byMonth = new Map<string, Trade[]>();
  for (const t of trades) {
    const m = new Date(t.signalTs).toISOString().slice(0, 7);
    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(t);
  }
  return [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, ts]) => ({ month, ...stats(ts) }));
}

async function loadSeries(): Promise<Series[]> {
  const rows = await db
    .select({
      instrumentKey: candlesTable.instrumentKey, timestamp: candlesTable.timestamp,
      open: candlesTable.open, high: candlesTable.high, low: candlesTable.low,
      close: candlesTable.close, volume: candlesTable.volume,
    })
    .from(candlesTable)
    .where(eq(candlesTable.interval, "day"))
    .orderBy(asc(candlesTable.instrumentKey), asc(candlesTable.timestamp));

  const byKey = new Map<string, { ts: number; open: number; high: number; low: number; close: number; volume: number }[]>();
  for (const r of rows) {
    const arr = byKey.get(r.instrumentKey) ?? byKey.set(r.instrumentKey, []).get(r.instrumentKey)!;
    arr.push({ ts: r.timestamp.getTime(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
  }
  const all: Series[] = [];
  for (const [key, arr] of byKey) {
    if (arr.length < WARMUP_BARS + 12) continue;
    all.push(buildSeries(key, arr));
  }
  return all;
}

async function main() {
  const sweep = process.argv.includes("--sweep");
  const all = await loadSeries();
  console.log(`Loaded ${all.length} instruments with >= ${WARMUP_BARS + 12} daily bars.`);
  console.log(`Liquidity: 20-bar avg turnover >= ${MIN_TURNOVER / 1e7} cr, price >= ${MIN_PRICE}. Cost ${COST_RATE_PER_SIDE * 100}%/side.\n`);

  if (sweep) {
    // ── Grid search on TRAIN ONLY (signal date <= 2026-04-30) ────────────────
    const grid: Config[] = [];
    for (const trigger of ["rsi5", "rsi10", "dn3", "rsi10dn2"] as Trigger[])
      for (const trendEma of [20, 30, 40] as const)
        for (const stopK of [1.0, 1.5, 2.0])
          for (const holdBars of [7, 10]) grid.push({ trigger, trendEma, stopK, holdBars });

    const out = grid.map((cfg) => {
      const train = runConfig(all, cfg).filter((t) => t.signalTs <= TRAIN_END);
      const st = stats(train);
      return { trigger: cfg.trigger, ema: cfg.trendEma, stopK: cfg.stopK, hold: cfg.holdBars, ...st };
    }).sort((a, b) => (b.expectancyPct ?? -99) - (a.expectancyPct ?? -99));
    console.log("TRAIN-ONLY sweep (2026-01-14 .. 2026-04-30), sorted by expectancy:");
    console.table(out);
    console.log("\nValidation window untouched. Pick a config from a stable plateau, then run without --sweep.");
  } else {
    const cfg: Config = FINAL;
    console.log(`FINAL CONFIG (tuned on train only): trigger=${cfg.trigger}, trend=close>EMA${cfg.trendEma}, stop=entry-${cfg.stopK}*ATR14, exit=close>EMA5 or RSI2>70, timeout=${cfg.holdBars} bars after fill, entry=limit at signal close good next bar only.\n`);
    const trades = runConfig(all, cfg);
    const train = trades.filter((t) => t.signalTs <= TRAIN_END);
    const valid = trades.filter((t) => t.signalTs > TRAIN_END);

    console.log("── TRAIN (signals 2026-01-14 .. 2026-04-30) ──");
    console.table([stats(train)]);
    console.table(monthly(train));

    console.log("── VALIDATION (signals 2026-05-01 .. 2026-07-14, untouched during tuning) ──");
    console.table([stats(valid)]);
    console.table(monthly(valid));

    console.log("winRatePct = wins/(wins+losses), ignores timeouts. expectancyPct = avg net %/filled trade (incl. timeouts).");
    console.log("maxConsecLosses = longest run of net-negative filled trades in signal-date order across the whole portfolio.");
    const v = stats(valid);
    if (v.fills < 40) console.log("WARNING: <40 validation fills — statistically weak.");
  }
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Research backtest failed:", err);
  process.exit(1);
});
