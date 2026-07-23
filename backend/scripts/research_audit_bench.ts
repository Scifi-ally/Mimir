/**
 * AUDIT (head-of-quant review, 2026-07-16): drift-adjusted alpha check for the
 * two research strategies that reported positive validation expectancy but no
 * market benchmark (meanrev, pullback).
 *
 * For every filled trade, alpha = trade net return − equal-weight universe index
 * return over the same signal→exit calendar window. If mean alpha ≈ 0 the
 * "edge" is just long-only beta on a rising tape. Also reports hold-duration
 * and per-signal-date clustering (correlated fills shrink the effective N).
 *
 * Read-only: replicates the exact simulation logic of research_meanrev.ts and
 * research_pullback.ts (FINAL/CHOSEN params, unchanged). No production files used.
 *
 * Run: npx tsx backend/scripts/research_audit_bench.ts
 */
import { db, candlesTable, pool } from "../db/src";
import { eq, asc } from "drizzle-orm";

const COST = 0.0005;
const TRAIN_END = new Date("2026-04-30T23:59:59+05:30").getTime();

interface Row { ts: number; o: number; h: number; l: number; c: number; v: number }

interface AuditTrade {
  key: string; signalTs: number; exitTs: number; holdBars: number; netPct: number; win: boolean;
}

// ── shared indicator helpers (copied verbatim in spirit from the research scripts) ──
function emaMeanrev(close: number[], period: number): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  if (close.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += close[i]!;
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < close.length; i++) out[i] = close[i]! * k + out[i - 1]! * (1 - k);
  return out;
}
function emaPullback(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(values.length);
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out[i] = values[i]!; continue; }
    if (i === period - 1) { let s = 0; for (let j = 0; j < period; j++) s += values[j]!; prev = s / period; }
    else prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rsi(close: number[], period: number): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  if (close.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = close[i]! - close[i - 1]!; if (d > 0) gain += d; else loss -= d; }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < close.length; i++) {
    const d = close[i]! - close[i - 1]!;
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function atrMeanrev(high: number[], low: number[], close: number[], period: number): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  if (close.length <= period) return out;
  const tr = (i: number) => Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!));
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr(i);
  out[period] = sum / period;
  for (let i = period + 1; i < close.length; i++) out[i] = (out[i - 1]! * (period - 1) + tr(i)) / period;
  return out;
}
function atrPullback(high: number[], low: number[], close: number[], period = 14): number[] {
  const n = high.length;
  const out: number[] = new Array(n).fill(0);
  if (n < 2) return out;
  let atr = 0, count = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!));
    if (count < period) { atr = (atr * count + tr) / (count + 1); count++; } else { atr = (atr * (period - 1) + tr) / period; }
    out[i] = atr;
  }
  return out;
}

// ── MEANREV: FINAL config (rsi10, EMA40, stopK 2.0, hold 10) ────────────────
function meanrevTrades(byKey: Map<string, Row[]>): AuditTrade[] {
  const trades: AuditTrade[] = [];
  for (const [key, rows] of byKey) {
    if (rows.length < 53) continue;
    const n = rows.length;
    const close = rows.map(r => r.c), high = rows.map(r => r.h), low = rows.map(r => r.l);
    const ema40 = emaMeanrev(close, 40), ema5 = emaMeanrev(close, 5);
    const rsi2 = rsi(close, 2), atr14 = atrMeanrev(high, low, close, 14);
    const turnover20 = new Array<number>(n).fill(NaN);
    let tSum = 0;
    for (let i = 0; i < n; i++) {
      tSum += close[i]! * rows[i]!.v;
      if (i >= 20) tSum -= close[i - 20]! * rows[i - 20]!.v;
      if (i >= 19) turnover20[i] = tSum / 20;
    }
    let busyUntil = -1;
    const HOLD = 10;
    for (let i = 41; i < n - 1 - HOLD; i++) {
      if (i <= busyUntil) continue;
      if (!Number.isFinite(ema40[i]!) || !Number.isFinite(atr14[i]!) || !Number.isFinite(rsi2[i]!)) continue;
      if (turnover20[i]! < 5e7 || close[i]! < 20) continue;
      if (close[i]! <= ema40[i]!) continue;
      if (!(rsi2[i]! < 10)) continue;
      const entry = close[i]!;
      const stop = entry - 2.0 * atr14[i]!;
      const fillIdx = i + 1;
      if (low[fillIdx]! > entry) { busyUntil = i + 1; continue; } // NO_FILL
      busyUntil = i + 1 + HOLD;
      const lastIdx = Math.min(fillIdx + HOLD, n - 1);
      let exitIdx = lastIdx, gross = (close[lastIdx]! - entry) / entry;
      for (let j = fillIdx; j <= lastIdx; j++) {
        if (low[j]! <= stop) { exitIdx = j; gross = (stop - entry) / entry; break; }
        if (close[j]! > ema5[j]! || rsi2[j]! > 70) { exitIdx = j; gross = (close[j]! - entry) / entry; break; }
      }
      const net = (gross - 2 * COST) * 100;
      trades.push({ key, signalTs: rows[i]!.ts, exitTs: rows[exitIdx]!.ts, holdBars: exitIdx - i, netPct: net, win: net > 0 });
    }
  }
  return trades;
}

// ── PULLBACK: CHOSEN params (vol 1.0, depth off, slope on, highWithin 10, 2R, hold 15) ──
function pullbackTrades(byKey: Map<string, Row[]>): AuditTrade[] {
  const trades: AuditTrade[] = [];
  const P = { volContraction: 1.0, requireSlope: true, highWithin: 10, rMultiple: 2, holdBars: 15 };
  for (const [key, rows] of byKey) {
    if (rows.length < 60) continue;
    const n = rows.length;
    const open = rows.map(r => r.o), high = rows.map(r => r.h), low = rows.map(r => r.l);
    const close = rows.map(r => r.c), volume = rows.map(r => r.v);
    const ema20 = emaPullback(close, 20), ema50 = emaPullback(close, 50);
    const atr14 = atrPullback(high, low, close, 14);
    const volSma20 = new Array<number>(n).fill(0);
    let vSum = 0;
    for (let i = 0; i < n; i++) { vSum += volume[i]!; if (i >= 20) vSum -= volume[i - 20]!; volSma20[i] = vSum / Math.min(i + 1, 20); }
    const high40 = new Array<number>(n).fill(0), high40Age = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const from = Math.max(0, i - 39);
      let hi = -Infinity, hiIdx = from;
      for (let j = from; j <= i; j++) if (high[j]! >= hi) { hi = high[j]!; hiIdx = j; }
      high40[i] = hi; high40Age[i] = i - hiIdx;
    }
    let lastSignalIdx = -Infinity;
    for (let i = 55; i < n - 1; i++) {
      if (i - lastSignalIdx < P.holdBars) continue;
      const c = close[i]!, atr = atr14[i]!;
      if (c < 20 || atr <= 0) continue;
      if (c * volSma20[i]! < 10_000_000) continue;
      if (!(ema20[i]! > ema50[i]! && c > ema50[i]!)) continue;
      if (P.requireSlope && !(ema50[i]! > ema50[i - 10]!)) continue;
      if (high40Age[i]! > P.highWithin) continue;
      let touched = false, pullbackLow = Infinity;
      for (let j = Math.max(0, i - 3); j <= i; j++) {
        if (low[j]! <= ema20[j]!) touched = true;
        if (low[j]! < pullbackLow) pullbackLow = low[j]!;
      }
      if (!touched) continue;
      if (pullbackLow < ema50[i]! - 0.25 * atr) continue;
      const pbFrom = Math.max(0, i - 3);
      let pbVol = 0;
      for (let j = pbFrom; j <= i; j++) pbVol += volume[j]!;
      pbVol /= i - pbFrom + 1;
      if (volSma20[i]! > 0 && pbVol / volSma20[i]! >= P.volContraction) continue;
      if (!(c > high[i - 1]! && c > open[i]! && c > ema20[i]!)) continue;
      lastSignalIdx = i;
      const stop = Math.min(pullbackLow - 0.1 * atr, c - 0.8 * atr);
      const entryBar = i + 1;
      const fill = open[entryBar]!;
      if (fill > c * 1.015) continue; // NO_FILL
      if (fill <= stop) {
        trades.push({ key, signalTs: rows[i]!.ts, exitTs: rows[entryBar]!.ts, holdBars: 1, netPct: (0 - 2 * COST) * 100, win: false });
        continue;
      }
      const risk = fill - stop;
      if (risk <= 0 || risk > fill * 0.08) continue; // NO_FILL
      const target = fill + P.rMultiple * risk;
      const lastIdx = Math.min(i + P.holdBars, n - 1);
      let exitIdx = lastIdx, exit = close[lastIdx]!;
      for (let b = entryBar; b <= lastIdx; b++) {
        if (low[b]! <= stop) { exitIdx = b; exit = b === entryBar && open[b]! < stop ? open[b]! : stop; break; }
        if (high[b]! >= target) { exitIdx = b; exit = b === entryBar && open[b]! > target ? open[b]! : target; break; }
      }
      const net = ((exit - fill) / fill - 2 * COST) * 100;
      trades.push({ key, signalTs: rows[i]!.ts, exitTs: rows[exitIdx]!.ts, holdBars: exitIdx - i, netPct: net, win: net > 0 });
    }
  }
  return trades;
}

function summarize(label: string, trades: AuditTrade[], idxByTs: Map<number, number>) {
  const val = trades.filter(t => t.signalTs > TRAIN_END);
  const withBench = val.map(t => {
    const i0 = idxByTs.get(t.signalTs), i1 = idxByTs.get(t.exitTs);
    const bench = i0 != null && i1 != null ? (i1 / i0 - 1) * 100 : null;
    return { ...t, bench, alpha: bench != null ? t.netPct - bench : null };
  }).filter(t => t.alpha != null) as (AuditTrade & { bench: number; alpha: number })[];

  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const nets = withBench.map(t => t.netPct), alphas = withBench.map(t => t.alpha), benches = withBench.map(t => t.bench);
  const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

  // clustering: fills per signal date; day-level alpha (equal-weight per day) for a
  // more honest SE than the per-trade one
  const byDay = new Map<number, number[]>();
  for (const t of withBench) (byDay.get(t.signalTs) ?? byDay.set(t.signalTs, []).get(t.signalTs)!).push(t.alpha);
  const dayAlphas = [...byDay.values()].map(mean);
  const maxPerDay = Math.max(...[...byDay.values()].map(a => a.length));

  console.log(`\n═══ ${label} — VALIDATION (signals > 2026-04-30) ═══`);
  console.log(`fills=${withBench.length}  meanNet=${mean(nets).toFixed(3)}%  meanBench(same window)=${mean(benches).toFixed(3)}%`);
  console.log(`ALPHA/trade = ${mean(alphas).toFixed(3)}%  (per-trade SE ${(sd(alphas) / Math.sqrt(alphas.length)).toFixed(3)}, t=${(mean(alphas) / (sd(alphas) / Math.sqrt(alphas.length))).toFixed(2)})`);
  console.log(`day-clustered: ${dayAlphas.length} signal dates, max ${maxPerDay} fills/day; day-level alpha=${mean(dayAlphas).toFixed(3)}% (SE ${(sd(dayAlphas) / Math.sqrt(dayAlphas.length)).toFixed(3)}, t=${(mean(dayAlphas) / (sd(dayAlphas) / Math.sqrt(dayAlphas.length))).toFixed(2)})`);
  console.log(`avg hold = ${mean(withBench.map(t => t.holdBars)).toFixed(2)} bars`);
}

async function main() {
  const rows = await db
    .select({ key: candlesTable.instrumentKey, t: candlesTable.timestamp,
      o: candlesTable.open, h: candlesTable.high, l: candlesTable.low, c: candlesTable.close, v: candlesTable.volume })
    .from(candlesTable)
    .where(eq(candlesTable.interval, "day"))
    .orderBy(asc(candlesTable.instrumentKey), asc(candlesTable.timestamp));

  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    (byKey.get(r.key) ?? byKey.set(r.key, []).get(r.key)!)
      .push({ ts: r.t.getTime(), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
  }

  // equal-weight universe index on the global calendar (xsmom-style, names with >=100 bars)
  const tsSet = new Set<number>();
  for (const arr of byKey.values()) for (const r of arr) tsSet.add(r.ts);
  const calendar = [...tsSet].sort((a, b) => a - b);
  const tsIdx = new Map(calendar.map((t, i) => [t, i]));
  const nBars = calendar.length;
  const sum = new Float64Array(nBars), cnt = new Float64Array(nBars);
  for (const arr of byKey.values()) {
    if (arr.length < 100) continue;
    const base = arr[0]!.c;
    if (!(base > 0)) continue;
    for (const r of arr) { const i = tsIdx.get(r.ts)!; sum[i] += r.c / base; cnt[i] += 1; }
  }
  const index = new Map<number, number>();
  for (let i = 0; i < nBars; i++) if (cnt[i]! > 0) index.set(calendar[i]!, sum[i]! / cnt[i]!);
  console.log(`${byKey.size} instruments, ${nBars} calendar bars, index members ~${Math.round(cnt[nBars - 1]!)}`);

  summarize("MEANREV (final config)", meanrevTrades(byKey), index);
  summarize("PULLBACK (chosen params)", pullbackTrades(byKey), index);

  await pool.end();
  process.exit(0);
}

main().catch((err) => { console.error("audit failed:", err); process.exit(1); });
