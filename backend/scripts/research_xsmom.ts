/**
 * research_xsmom.ts — Cross-sectional momentum / relative-strength rotation research.
 *
 * Strategy family: every K bars, rank the liquid universe by trailing L-bar return
 * skipping the most recent `skip` bars (momentum ex-reversal), go long the top
 * `topFrac` fraction, gated by a market-regime filter (equal-weight universe index
 * above its EMA50). Hold K bars, optional fixed % stop.
 *
 * Honesty rules (mirrors backtest_setups.ts conventions):
 *   - No look-ahead: ranks at bar i use only bars <= i; entry fills at bar i+1 OPEN.
 *   - Signals with no next bar are dropped; missing next-bar open = NO_FILL.
 *   - Stop checked pessimistically: gap below stop exits at the (worse) open;
 *     stop checked before the time exit within every bar.
 *   - 0.05% cost per side (0.1% round trip) on every filled position.
 *   - Train window 2026-01-13..2026-04-30 for ALL tuning; positions whose exit
 *     bleeds past the train end are embargoed (counted, used by neither window).
 *     Validation = signals 2026-05-01..end, untouched by tuning.
 *
 * NOTE: the DB holds only 122 daily bars, so the classical 60-90 bar momentum
 * lookback is infeasible (it would leave no train signals). Lookback is tuned
 * over {15,20,30,40} on train only.
 *
 * Run: npx tsx backend/scripts/research_xsmom.ts
 *      [--minTurnover 50000000] [--minPrice 20] [--gridOnly]
 */
import { db, candlesTable } from "../db/src";
import { and, eq, asc } from "drizzle-orm";

const COST_RATE_PER_SIDE = 0.0005; // keep in sync with backtest_setups.ts
const TRAIN_END = "2026-04-30";
const VAL_START = "2026-05-01";
const GLOBAL_WARMUP = 45; // regime EMA50 (recursively seeded) needs runway
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

interface Series {
  key: string;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  medTurnover: Float64Array; // trailing 20-bar median of close*volume
}

interface Position {
  key: string;
  signalBar: number;
  signalDate: string;
  entryBar: number;
  entry: number;
  exitBar: number;
  exit: number;
  outcome: "STOP" | "TIME" | "TIME_EOD" | "NO_FILL";
  netPct: number; // net of costs, 0 for NO_FILL
}

interface ComboParams {
  L: number;
  skip: number;
  K: number;
  topFrac: number;
  stopPct: number; // 0 = no stop
}

interface Rebalance {
  bar: number;
  date: string;
  regimeOk: boolean;
  positions: Position[];
}

function comboLabel(p: ComboParams): string {
  return `L=${p.L} skip=${p.skip} K=${p.K} top=${p.topFrac} stop=${p.stopPct ? p.stopPct * 100 + "%" : "none"}`;
}

/** Median of finite values in-place-sorted copy; NaN if fewer than minCount. */
function median(vals: number[], minCount: number): number {
  if (vals.length < minCount) return NaN;
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Simulate one long position: fill at open of signalBar+1, fixed % stop
 *  (pessimistic on gaps, checked before the time exit), else exit at the close
 *  of the K-th held bar. */
function simulate(
  s: Series,
  signalBar: number,
  signalDate: string,
  K: number,
  stopPct: number,
  nBars: number,
): Position {
  const e = signalBar + 1;
  const entry = s.open[e]!;
  const base: Omit<Position, "exitBar" | "exit" | "outcome" | "netPct"> = {
    key: s.key, signalBar, signalDate, entryBar: e, entry,
  };
  if (!Number.isFinite(entry) || entry <= 0) {
    return { ...base, exitBar: e, exit: NaN, outcome: "NO_FILL", netPct: 0 };
  }
  const stop = stopPct > 0 ? entry * (1 - stopPct) : -Infinity;
  const lastHoldBar = e + K - 1;
  let lastSeenClose = NaN;
  let lastSeenBar = e;

  for (let j = e; j <= Math.min(lastHoldBar, nBars - 1); j++) {
    const o = s.open[j]!, lo = s.low[j]!, c = s.close[j]!;
    if (!Number.isFinite(c)) continue; // trading halt / missing bar
    lastSeenClose = c;
    lastSeenBar = j;
    if (stopPct > 0) {
      if (Number.isFinite(o) && o <= stop) {
        // gapped through the stop: fill at the worse open price
        const net = (o / entry - 1 - 2 * COST_RATE_PER_SIDE) * 100;
        return { ...base, exitBar: j, exit: o, outcome: "STOP", netPct: net };
      }
      if (Number.isFinite(lo) && lo <= stop) {
        const net = (stop / entry - 1 - 2 * COST_RATE_PER_SIDE) * 100;
        return { ...base, exitBar: j, exit: stop, outcome: "STOP", netPct: net };
      }
    }
  }

  if (!Number.isFinite(lastSeenClose)) {
    // no tradable bar in the whole window — treat as unfilled
    return { ...base, exitBar: e, exit: NaN, outcome: "NO_FILL", netPct: 0 };
  }
  const truncated = lastHoldBar > nBars - 1;
  const net = (lastSeenClose / entry - 1 - 2 * COST_RATE_PER_SIDE) * 100;
  return {
    ...base, exitBar: lastSeenBar, exit: lastSeenClose,
    outcome: truncated ? "TIME_EOD" : "TIME", netPct: net,
  };
}

function runCombo(
  p: ComboParams,
  series: Series[],
  dates: string[],
  regimeOk: boolean[],
  minTurnover: number,
  minPrice: number,
): Rebalance[] {
  const nBars = dates.length;
  const start = Math.max(p.L + p.skip + 1, GLOBAL_WARMUP);
  const rebalances: Rebalance[] = [];

  for (let i = start; i < nBars - 1; i += p.K) {
    const reb: Rebalance = { bar: i, date: dates[i]!, regimeOk: regimeOk[i]!, positions: [] };
    rebalances.push(reb);
    if (!reb.regimeOk) continue;

    const eligible: { s: Series; mom: number }[] = [];
    for (const s of series) {
      const c = s.close[i]!;
      const cRecent = s.close[i - p.skip]!;
      const cPast = s.close[i - p.skip - p.L]!;
      if (!Number.isFinite(c) || c < minPrice) continue;
      if (!Number.isFinite(cRecent) || !Number.isFinite(cPast) || cPast <= 0) continue;
      if (!(s.medTurnover[i]! >= minTurnover)) continue;
      eligible.push({ s, mom: cRecent / cPast - 1 });
    }
    if (eligible.length < 50) continue; // universe too thin to rank

    eligible.sort((a, b) => b.mom - a.mom);
    const nPick = Math.max(1, Math.floor(eligible.length * p.topFrac));
    for (let r = 0; r < nPick; r++) {
      reb.positions.push(simulate(eligible[r]!.s, i, dates[i]!, p.K, p.stopPct, nBars));
    }
  }
  return rebalances;
}

interface Stats {
  signals: number;
  fills: number;
  noFills: number;
  wins: number;
  losses: number;
  stopOuts: number;
  timeouts: number;
  timeoutsEod: number;
  winRatePct: number | null; // wins/(wins+losses) among decided (net != 0)
  expectancyPct: number; // avg net % per filled position
  maxConsecLossPositions: number;
  rebalancesTraded: number;
  avgRebalanceRetPct: number; // equal-weight mean position return per rebalance, averaged
  maxConsecLossRebalances: number;
}

function computeStats(positions: Position[], rebKeys: string[]): Stats {
  const filled = positions.filter((t) => t.outcome !== "NO_FILL");
  const wins = filled.filter((t) => t.netPct > 0).length;
  const losses = filled.filter((t) => t.netPct < 0).length;
  const stopOuts = filled.filter((t) => t.outcome === "STOP").length;
  const timeouts = filled.filter((t) => t.outcome === "TIME").length;
  const timeoutsEod = filled.filter((t) => t.outcome === "TIME_EOD").length;
  const expectancy = filled.length ? filled.reduce((a, t) => a + t.netPct, 0) / filled.length : 0;

  let maxConsecPos = 0, run = 0;
  for (const t of filled) { // positions arrive in (rebalance, rank) order
    if (t.netPct < 0) { run++; maxConsecPos = Math.max(maxConsecPos, run); }
    else run = 0;
  }

  const byReb = new Map<string, number[]>();
  for (const t of filled) {
    const arr = byReb.get(t.signalDate) ?? [];
    arr.push(t.netPct);
    byReb.set(t.signalDate, arr);
  }
  const rebMeans = rebKeys.filter((d) => byReb.has(d)).map((d) => {
    const arr = byReb.get(d)!;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  });
  let maxConsecReb = 0; run = 0;
  for (const m of rebMeans) {
    if (m < 0) { run++; maxConsecReb = Math.max(maxConsecReb, run); }
    else run = 0;
  }

  return {
    signals: positions.length,
    fills: filled.length,
    noFills: positions.length - filled.length,
    wins, losses, stopOuts, timeouts, timeoutsEod,
    winRatePct: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
    expectancyPct: Math.round(expectancy * 1000) / 1000,
    maxConsecLossPositions: maxConsecPos,
    rebalancesTraded: rebMeans.length,
    avgRebalanceRetPct: rebMeans.length
      ? Math.round((rebMeans.reduce((a, b) => a + b, 0) / rebMeans.length) * 1000) / 1000
      : 0,
    maxConsecLossRebalances: maxConsecReb,
  };
}

function monthlyBreakdown(positions: Position[]) {
  const byMonth = new Map<string, Position[]>();
  for (const t of positions) {
    const m = t.signalDate.slice(0, 7);
    const arr = byMonth.get(m) ?? [];
    arr.push(t);
    byMonth.set(m, arr);
  }
  return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, ts]) => {
    const filled = ts.filter((t) => t.outcome !== "NO_FILL");
    const wins = filled.filter((t) => t.netPct > 0).length;
    const losses = filled.filter((t) => t.netPct < 0).length;
    return {
      month,
      positions: ts.length,
      fills: filled.length,
      wins, losses,
      winRatePct: wins + losses ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
      avgNetPct: filled.length
        ? Math.round((filled.reduce((a, t) => a + t.netPct, 0) / filled.length) * 1000) / 1000
        : 0,
    };
  });
}

async function main() {
  const minTurnover = argNum("minTurnover", 5e7); // >= ₹5 crore avg daily turnover
  const minPrice = argNum("minPrice", 20);
  const gridOnly = process.argv.includes("--gridOnly");

  console.log("Loading daily candles…");
  const rows = await db
    .select({
      key: candlesTable.instrumentKey,
      t: candlesTable.timestamp,
      o: candlesTable.open,
      h: candlesTable.high,
      l: candlesTable.low,
      c: candlesTable.close,
      v: candlesTable.volume,
    })
    .from(candlesTable)
    .where(eq(candlesTable.interval, "day"))
    .orderBy(asc(candlesTable.instrumentKey), asc(candlesTable.timestamp));

  // Global trading calendar (dates are stored as midnight IST)
  const toDate = (t: Date) => new Date(t.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const dateSet = new Set<string>();
  for (const r of rows) dateSet.add(toDate(r.t));
  const dates = [...dateSet].sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const nBars = dates.length;
  console.log(`${rows.length} candles, ${nBars} trading days: ${dates[0]} .. ${dates[nBars - 1]}`);

  // Per-instrument series aligned to the calendar
  const byKey = new Map<string, Series & { turnover: Float64Array }>();
  for (const r of rows) {
    let s = byKey.get(r.key);
    if (!s) {
      s = {
        key: r.key,
        open: new Float64Array(nBars).fill(NaN),
        high: new Float64Array(nBars).fill(NaN),
        low: new Float64Array(nBars).fill(NaN),
        close: new Float64Array(nBars).fill(NaN),
        medTurnover: new Float64Array(nBars).fill(NaN),
        turnover: new Float64Array(nBars).fill(NaN),
      };
      byKey.set(r.key, s);
    }
    const i = dateIdx.get(toDate(r.t))!;
    s.open[i] = r.o; s.high[i] = r.h; s.low[i] = r.l; s.close[i] = r.c;
    s.turnover[i] = r.c * r.v;
  }

  // Trailing 20-bar median turnover (needs >= 15 present bars)
  for (const s of byKey.values()) {
    for (let i = 19; i < nBars; i++) {
      const w: number[] = [];
      for (let j = i - 19; j <= i; j++) if (Number.isFinite(s.turnover[j]!)) w.push(s.turnover[j]!);
      s.medTurnover[i] = median(w, 15);
    }
  }
  const series: Series[] = [...byKey.values()];

  // Regime filter: equal-weight universe index (each name normalized to its first
  // close) vs its EMA50 (recursively seeded — biased early, hence GLOBAL_WARMUP).
  const index = new Float64Array(nBars).fill(NaN);
  const bases = series
    .map((s) => {
      let barCount = 0, firstIdx = -1;
      for (let i = 0; i < nBars; i++) {
        if (Number.isFinite(s.close[i]!)) { barCount++; if (firstIdx < 0) firstIdx = i; }
      }
      return { s, barCount, base: firstIdx >= 0 ? s.close[firstIdx]! : NaN };
    })
    .filter((x) => x.barCount >= 100 && Number.isFinite(x.base) && x.base > 0);
  for (let i = 0; i < nBars; i++) {
    let sum = 0, n = 0;
    for (const { s, base } of bases) {
      const c = s.close[i]!;
      if (Number.isFinite(c)) { sum += c / base; n++; }
    }
    index[i] = n > 0 ? sum / n : NaN;
  }
  const ema50 = new Float64Array(nBars).fill(NaN);
  const alpha = 2 / 51;
  let ema = NaN;
  for (let i = 0; i < nBars; i++) {
    const v = index[i]!;
    if (!Number.isFinite(v)) { ema50[i] = ema; continue; }
    ema = Number.isFinite(ema) ? alpha * v + (1 - alpha) * ema : v;
    ema50[i] = ema;
  }
  const regimeOk = dates.map((_, i) => Number.isFinite(index[i]!) && index[i]! > ema50[i]!);
  console.log(`Universe-index members: ${bases.length}; regime-OK on ${regimeOk.filter(Boolean).length}/${nBars} bars`);

  const trainEndIdx = dates.filter((d) => d <= TRAIN_END).length - 1;

  // ── Grid search on TRAIN only ─────────────────────────────────────────────
  const grid: ComboParams[] = [];
  for (const L of [15, 20, 30, 40])
    for (const skip of [3, 5])
      for (const K of [5, 10])
        for (const topFrac of [0.1, 0.2])
          for (const stopPct of [0, 0.08])
            grid.push({ L, skip, K, topFrac, stopPct });

  // Classify at REBALANCE level, so a stop can't selectively pull a straddling
  // rebalance's early (losing) exits into the train sample:
  //   TRAIN   = the whole K-bar hold window fits inside the train window
  //   EMBARGO = signaled in train but the hold window crosses TRAIN_END
  //   VAL     = signaled on/after VAL_START
  const classify = (r: Rebalance, K: number): "TRAIN" | "EMBARGO" | "VAL" =>
    r.date >= VAL_START ? "VAL" : r.bar + K <= trainEndIdx ? "TRAIN" : "EMBARGO";

  interface GridRow { p: ComboParams; train: Stats; rebalances: Rebalance[] }
  const results: GridRow[] = [];
  for (const p of grid) {
    const rebalances = runCombo(p, series, dates, regimeOk, minTurnover, minPrice);
    const trainPositions = rebalances
      .filter((r) => classify(r, p.K) === "TRAIN")
      .flatMap((r) => r.positions);
    const rebKeys = rebalances.map((r) => r.date);
    results.push({ p, train: computeStats(trainPositions, rebKeys), rebalances });
  }

  console.log(`\n═══ GRID SEARCH — TRAIN ONLY (${dates[0]}..${TRAIN_END}, fully-contained trades) ═══`);
  const gridTable = results
    .map((r) => ({
      combo: comboLabel(r.p),
      signals: r.train.signals,
      fills: r.train.fills,
      winRatePct: r.train.winRatePct,
      expectancyPct: r.train.expectancyPct,
      avgRebRetPct: r.train.avgRebalanceRetPct,
      rebs: r.train.rebalancesTraded,
    }))
    .sort((a, b) => b.expectancyPct - a.expectancyPct);
  console.table(gridTable.slice(0, 15));
  console.log(`(showing top 15 of ${gridTable.length} combos by train expectancy)`);

  // Selection: best train expectancy among combos with a usable sample.
  // Require >=2 independent train rebalances (a single hot rebalance is not a
  // tunable sample) and >=40 filled positions. NOTE: because the regime gate
  // correctly blocks Feb-20..Apr-07 (universe below EMA50), the train window
  // physically offers at most ~2-3 tradable rebalances — tuning here is WEAK
  // and the validation window carries most of the evidential weight.
  const viable = results.filter((r) => r.train.fills >= 40 && r.train.rebalancesTraded >= 2);
  viable.sort((a, b) => b.train.expectancyPct - a.train.expectancyPct);
  if (viable.length === 0) {
    console.log("\nNo combo produced >=40 filled train positions across >=2 rebalances — cannot tune honestly. Stopping.");
    process.exit(0);
  }
  const chosen = viable[0]!;
  console.log(`\nCHOSEN ON TRAIN: ${comboLabel(chosen.p)} (train fills=${chosen.train.fills} across ${chosen.train.rebalancesTraded} rebalances, expectancy=${chosen.train.expectancyPct}%)`);
  console.log("(train offers only ~2 regime-open rebalances — tuning is weak by construction; see validation)");
  if (gridOnly) process.exit(0);

  // Family robustness (report-only, no re-selection): distribution of
  // validation expectancy across ALL grid combos.
  const valExpAll = results.map((r) => {
    const pos = r.rebalances.filter((x) => classify(x, r.p.K) === "VAL").flatMap((x) => x.positions);
    const filled = pos.filter((t) => t.outcome !== "NO_FILL");
    return filled.length ? filled.reduce((a, t) => a + t.netPct, 0) / filled.length : NaN;
  }).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (f: number) => valExpAll[Math.min(valExpAll.length - 1, Math.floor(f * valExpAll.length))]!;
  console.log(`\nFamily robustness — validation expectancy across all ${valExpAll.length} combos (NOT used for selection):`);
  console.log(`  min=${q(0).toFixed(3)}%  p25=${q(0.25).toFixed(3)}%  median=${q(0.5).toFixed(3)}%  p75=${q(0.75).toFixed(3)}%  max=${valExpAll[valExpAll.length - 1]!.toFixed(3)}%  negative: ${valExpAll.filter((v) => v < 0).length}/${valExpAll.length}`);

  // ── Final report: chosen combo on train AND untouched validation ─────────
  const rebalances = chosen.rebalances;
  const rebKeys = rebalances.map((r) => r.date);
  const bucket = (w: "TRAIN" | "EMBARGO" | "VAL") =>
    rebalances.filter((r) => classify(r, chosen.p.K) === w).flatMap((r) => r.positions);
  const trainPos = bucket("TRAIN");
  const embargoPos = bucket("EMBARGO");
  const valPos = bucket("VAL");

  const fmt = (label: string, st: Stats) => ({
    window: label,
    signals: st.signals,
    fills: st.fills,
    noFills: st.noFills,
    wins: st.wins,
    losses: st.losses,
    stopOuts: st.stopOuts,
    timeouts: st.timeouts + st.timeoutsEod,
    winRatePct: st.winRatePct,
    expectancyPct: st.expectancyPct,
    avgRebRetPct: st.avgRebalanceRetPct,
    maxConsecLossPos: st.maxConsecLossPositions,
    maxConsecLossRebs: st.maxConsecLossRebalances,
  });

  const trainStats = computeStats(trainPos, rebKeys);
  const valStats = computeStats(valPos, rebKeys);
  console.log(`\n═══ FINAL — ${comboLabel(chosen.p)} ═══`);
  console.log(`Embargoed positions (signaled in train, exit after ${TRAIN_END}; used by neither window): ${embargoPos.length}`);
  console.table([
    fmt(`TRAIN ${dates[0]}..${TRAIN_END}`, trainStats),
    fmt(`VALIDATION ${VAL_START}..${dates[nBars - 1]}`, valStats),
  ]);
  console.log("winRatePct = wins/(wins+losses) on decided (net!=0) fills; timeouts (time exits) are the normal rotation exit and count as win/loss by sign.");
  console.log("expectancyPct = avg net %/position after 0.05%/side. avgRebRetPct = equal-weight portfolio return per rebalance, averaged.");
  const eodCount = valStats.timeoutsEod;
  if (eodCount > 0) console.log(`NOTE: ${eodCount} validation positions were force-closed at the last close (data end).`);
  if (valStats.fills < 40) console.log("WARNING: <40 validation fills — statistically weak.");

  console.log("\nPer-month breakdown (by signal month, filled positions):");
  console.table(monthlyBreakdown([...trainPos, ...embargoPos.map((t) => ({ ...t })), ...valPos].map((t) => t)));
  console.log("(months overlapping the train/validation boundary include embargoed trades; the split tables above are authoritative)");

  console.log("\nPer-rebalance detail (chosen combo). benchPct = equal-weight universe index over the same hold window (close[signal]..close[signal+K]), gross:");
  const detail = rebalances.map((r) => {
    const filled = r.positions.filter((t) => t.outcome !== "NO_FILL");
    const mean = filled.length ? filled.reduce((a, t) => a + t.netPct, 0) / filled.length : null;
    const bEnd = Math.min(r.bar + chosen.p.K, nBars - 1);
    const bench = Number.isFinite(index[r.bar]!) && Number.isFinite(index[bEnd]!)
      ? (index[bEnd]! / index[r.bar]! - 1) * 100
      : null;
    return {
      date: r.date,
      window: classify(r, chosen.p.K),
      regimeOk: r.regimeOk,
      positions: r.positions.length,
      fills: filled.length,
      meanNetPct: mean != null ? Math.round(mean * 1000) / 1000 : null,
      benchPct: bench != null ? Math.round(bench * 1000) / 1000 : null,
      excessPct: mean != null && bench != null ? Math.round((mean - bench) * 1000) / 1000 : null,
    };
  });
  console.table(detail);
  const valDetail = detail.filter((d) => d.window === "VAL" && d.meanNetPct != null && d.benchPct != null);
  if (valDetail.length) {
    const mExc = valDetail.reduce((a, d) => a + d.excessPct!, 0) / valDetail.length;
    const mBench = valDetail.reduce((a, d) => a + d.benchPct!, 0) / valDetail.length;
    console.log(`VALIDATION: avg benchmark/rebalance = ${mBench.toFixed(3)}%, avg excess over universe = ${mExc.toFixed(3)}%/rebalance (net strategy vs gross index)`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("research_xsmom failed:", err);
  process.exit(1);
});
