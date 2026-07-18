/**
 * QUALITY-FILTER STUDY — copy of backtest_setups.ts (original untouched).
 *
 * Replays each stock's daily history exactly like backtest_setups.ts (same
 * detectors, same honest fill rules, same cooldown, same costs), but for every
 * emitted signal also computes five quality-filter booleans from data visible
 * AT OR BEFORE the signal bar only:
 *
 *   TREND    close > EMA50 for longs / close < EMA50 for shorts
 *   VOLUME   signal-bar volume >= 1.5x the prior-20-bar average volume
 *   RSI      reject overbought (RSI14 > 70) longs / oversold (RSI14 < 30) shorts
 *   RS       60-bar return minus equal-weight universe mean 60-bar return
 *            (same calendar date, instruments with >= 60 prior bars only);
 *            must be > 0 for longs, < 0 for shorts
 *   STOPATR  |entry - stop| / ATR14 >= 0.8 (reject noise-tight stops)
 *
 * Each signal is simulated ONCE; filters only gate which trades count toward
 * each config's stats. Reported per setup: baseline, each filter alone,
 * all-filters-combined, plus a full 2^5 subset sweep (min 30 filled trades)
 * to rank filter combinations. Results are written to <repoRoot>/.backtest_filters.md.
 *
 * NO LOOK-AHEAD:
 *   - snapshot indicators (EMA50, RSI14, ATR14, volumeRatio) come from
 *     buildSnapshot(candles.slice(0, i+1)) — bars <= signal index only
 *   - volumeRatio = vol[i] / mean(vol[i-20..i-1])  (computeVolumeRatio)
 *   - own 60-bar return = close[i] / close[i-60] - 1
 *   - universe mean for date D averages ret60 values whose latest bar IS date D
 *     (each constituent uses only its own closes at/before D)
 *
 * Run: npx tsx backend/scripts/backtest_filters.ts [--days 365] [--holdBars 5] [--rMultiple 2] [--only SETUP_TYPE]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, candlesTable } from "../db/src";
import { and, eq, gte, asc } from "drizzle-orm";
import {
  buildSnapshot,
  detectBreakout,
  detectPullback,
  detectMomentum,
  detectEma9Reclaim,
  detectBreakdown,
  detectBearMomentum,
  detectEma9Rejection,
  detectMacdCrossover,
  detectBollingerSqueezeBreakout,
  detectLiquiditySweep,
  type OHLCV,
  type SetupCandidate,
} from "../src/analysis/technical";

const DETECTORS = [
  detectBreakout,
  detectPullback,
  detectMomentum,
  detectEma9Reclaim,
  detectBreakdown,
  detectBearMomentum,
  detectEma9Rejection,
  detectMacdCrossover,
  detectBollingerSqueezeBreakout,
  detectLiquiditySweep,
];

const COST_RATE_PER_SIDE = 0.0005; // keep in sync with accuracy_tracker
const WARMUP_BARS = 60;
const RS_LOOKBACK = 60; // bars for relative-strength return
const VOLUME_SURGE_MIN = 1.5;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
const MIN_STOP_ATR = 0.8;
const MIN_FILLED_FOR_SWEEP = 30; // subset sweep: ignore configs with fewer filled trades

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

function argStr(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

interface TradeResult {
  setupType: string;
  direction: "BUY" | "SELL";
  outcome: "WIN" | "LOSS" | "NO_FILL" | "TIMEOUT";
  returnPct: number; // net of costs, 0 for NO_FILL
}

const FILTER_KEYS = ["TREND", "VOLUME", "RSI", "RS", "STOPATR"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type FilterFlags = Record<FilterKey, boolean>;

interface StudyTrade {
  trade: TradeResult;
  flags: FilterFlags;
}

/** Walk forward from signal bar; honest fill + pessimistic intrabar tie-break.
 *  Byte-identical to backtest_setups.ts so the baseline reproduces exactly. */
function simulate(candles: OHLCV[], signalIdx: number, setup: SetupCandidate, holdBars: number): TradeResult {
  const { direction, entryPrice, stopLoss, target1, setupType } = setup;
  const isBuy = direction === "BUY";
  let filled = false;

  for (let i = signalIdx + 1; i < Math.min(signalIdx + 1 + holdBars, candles.length); i++) {
    const bar = candles[i]!;

    if (!filled) {
      const touched = isBuy ? bar.low <= entryPrice : bar.high >= entryPrice;
      if (!touched) continue;
      // Gapped through target before fill = no realistic fill with edge intact
      const gappedPastTarget = isBuy ? bar.open >= target1 : bar.open <= target1;
      if (gappedPastTarget) return { setupType, direction, outcome: "NO_FILL", returnPct: 0 };
      filled = true;
    }

    const stopHit = isBuy ? bar.low <= stopLoss : bar.high >= stopLoss;
    const targetHit = isBuy ? bar.high >= target1 : bar.low <= target1;

    // Stop before target when both are inside the same bar — pessimistic
    if (stopHit) {
      const gross = isBuy ? (stopLoss - entryPrice) / entryPrice : (entryPrice - stopLoss) / entryPrice;
      return { setupType, direction, outcome: "LOSS", returnPct: (gross - 2 * COST_RATE_PER_SIDE) * 100 };
    }
    if (targetHit) {
      const gross = isBuy ? (target1 - entryPrice) / entryPrice : (entryPrice - target1) / entryPrice;
      return { setupType, direction, outcome: "WIN", returnPct: (gross - 2 * COST_RATE_PER_SIDE) * 100 };
    }
  }

  if (!filled) return { setupType, direction, outcome: "NO_FILL", returnPct: 0 };

  // Timed out holding: exit at last close inside window
  const lastIdx = Math.min(signalIdx + holdBars, candles.length - 1);
  const exit = candles[lastIdx]!.close;
  const gross = isBuy ? (exit - entryPrice) / entryPrice : (entryPrice - exit) / entryPrice;
  return { setupType, direction, outcome: "TIMEOUT", returnPct: (gross - 2 * COST_RATE_PER_SIDE) * 100 };
}

// ── Relative-strength pre-pass ────────────────────────────────────────────────
// For every instrument bar with >= RS_LOOKBACK prior bars, compute the trailing
// 60-bar return keyed by that bar's calendar date, and accumulate the
// equal-weight universe sum/count per date. Everything uses closes at or
// before the keyed date, so main-loop lookups by signal-bar date are
// look-ahead-free.
interface UniverseRS {
  own: Map<string, Map<string, number>>; // instrumentKey -> dateStr -> ret60
  uni: Map<string, { sum: number; n: number }>; // dateStr -> aggregate
}

async function buildUniverseRS(since: Date): Promise<UniverseRS> {
  const rows = await db
    .select({
      instrumentKey: candlesTable.instrumentKey,
      timestamp: candlesTable.timestamp,
      close: candlesTable.close,
    })
    .from(candlesTable)
    .where(and(eq(candlesTable.interval, "day"), gte(candlesTable.timestamp, since)))
    .orderBy(asc(candlesTable.instrumentKey), asc(candlesTable.timestamp));

  const own = new Map<string, Map<string, number>>();
  const uni = new Map<string, { sum: number; n: number }>();

  let curKey = "";
  let closes: number[] = [];
  let dates: string[] = [];

  const flush = () => {
    if (!curKey) return;
    const perDate = new Map<string, number>();
    for (let i = RS_LOOKBACK; i < closes.length; i++) {
      const base = closes[i - RS_LOOKBACK]!;
      if (base <= 0) continue;
      const ret = closes[i]! / base - 1;
      const d = dates[i]!;
      perDate.set(d, ret);
      const agg = uni.get(d) ?? { sum: 0, n: 0 };
      agg.sum += ret;
      agg.n += 1;
      uni.set(d, agg);
    }
    if (perDate.size > 0) own.set(curKey, perDate);
  };

  for (const r of rows) {
    if (r.instrumentKey !== curKey) {
      flush();
      curKey = r.instrumentKey;
      closes = [];
      dates = [];
    }
    closes.push(r.close);
    dates.push(r.timestamp.toISOString().slice(0, 10));
  }
  flush();

  return { own, uni };
}

// ── Stats aggregation ─────────────────────────────────────────────────────────

interface ConfigStats {
  config: string;
  signals: number;
  filled: number;
  wins: number;
  losses: number;
  timeouts: number;
  noFills: number;
  winRatePct: number | null;
  expectancyPct: number | null;
  retentionPct: number; // signals kept vs baseline
}

function statsFor(config: string, ts: TradeResult[], baselineSignals: number): ConfigStats {
  const wins = ts.filter((t) => t.outcome === "WIN").length;
  const losses = ts.filter((t) => t.outcome === "LOSS").length;
  const timeouts = ts.filter((t) => t.outcome === "TIMEOUT").length;
  const noFills = ts.filter((t) => t.outcome === "NO_FILL").length;
  const decided = ts.filter((t) => t.outcome !== "NO_FILL");
  const avgReturn = decided.length ? decided.reduce((a, t) => a + t.returnPct, 0) / decided.length : null;
  return {
    config,
    signals: ts.length,
    filled: decided.length,
    wins, losses, timeouts, noFills,
    winRatePct: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
    expectancyPct: avgReturn == null ? null : Math.round(avgReturn * 1000) / 1000,
    retentionPct: baselineSignals > 0 ? Math.round((ts.length / baselineSignals) * 1000) / 10 : 0,
  };
}

function passesMask(flags: FilterFlags, mask: number): boolean {
  for (let b = 0; b < FILTER_KEYS.length; b++) {
    if (mask & (1 << b) && !flags[FILTER_KEYS[b]!]) return false;
  }
  return true;
}

function maskName(mask: number): string {
  if (mask === 0) return "baseline";
  return FILTER_KEYS.filter((_, b) => mask & (1 << b)).join("+");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const days = argNum("days", 365);
  const holdBars = argNum("holdBars", 5);
  const rMultiple = argNum("rMultiple", 0); // 0 = use detector's own target
  const only = argStr("only");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log("Building equal-weight universe 60-bar return series (RS filter pre-pass)...");
  const rs = await buildUniverseRS(since);
  console.log(`RS pre-pass done: ${rs.own.size} instruments, ${rs.uni.size} dates with universe mean.\n`);

  const instruments = await db
    .selectDistinct({ instrumentKey: candlesTable.instrumentKey })
    .from(candlesTable)
    .where(and(eq(candlesTable.interval, "day"), gte(candlesTable.timestamp, since)));

  console.log(`Backtesting ${instruments.length} instruments, ${days}d lookback, ${holdBars}-bar hold, cost ${COST_RATE_PER_SIDE * 100}%/side\n`);
  if (instruments.length === 0) {
    console.log("No daily candles in DB. Run a scan first to populate candlesTable.");
    process.exit(0);
  }

  const studyTrades: StudyTrade[] = [];

  for (const { instrumentKey } of instruments) {
    const rows = await db
      .select()
      .from(candlesTable)
      .where(
        and(
          eq(candlesTable.instrumentKey, instrumentKey),
          eq(candlesTable.interval, "day"),
          gte(candlesTable.timestamp, since),
        ),
      )
      .orderBy(asc(candlesTable.timestamp));

    if (rows.length < WARMUP_BARS + holdBars) continue;

    const candles: OHLCV[] = rows.map((r) => ({
      timestamp: r.timestamp.toISOString(),
      open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    }));

    const ownRS = rs.own.get(instrumentKey);

    // Per-symbol cooldown so one persistent condition doesn't spam signals
    const lastSignalIdx = new Map<string, number>();

    for (let i = WARMUP_BARS; i < candles.length - holdBars; i++) {
      const visible = candles.slice(0, i + 1);
      const snap = buildSnapshot(visible);
      if (!snap) continue;

      // Filter inputs shared by every setup emitted on this bar. All derived
      // from bars <= i (snapshot is built from `visible` only).
      const dateStr = candles[i]!.timestamp.slice(0, 10);
      const ownRet60 = ownRS?.get(dateStr);
      const uniAgg = rs.uni.get(dateStr);
      const uniMean = uniAgg && uniAgg.n > 0 ? uniAgg.sum / uniAgg.n : null;

      for (const detect of DETECTORS) {
        let setup: SetupCandidate | null = null;
        try {
          setup = detect(visible, snap);
        } catch { /* detector threw on edge-case data; skip */ }
        if (!setup) continue;
        if (only && setup.setupType !== only) continue;
        if (rMultiple > 0) {
          const risk = Math.abs(setup.entryPrice - setup.stopLoss);
          setup.target1 = setup.direction === "BUY"
            ? setup.entryPrice + rMultiple * risk
            : setup.entryPrice - rMultiple * risk;
          if (setup.target1 <= 0) continue;
        }
        const prev = lastSignalIdx.get(setup.setupType);
        if (prev != null && i - prev < holdBars) continue; // still "in" prior trade
        lastSignalIdx.set(setup.setupType, i);

        const isBuy = setup.direction === "BUY";
        const stopDist = Math.abs(setup.entryPrice - setup.stopLoss);
        const relStrength = ownRet60 != null && uniMean != null ? ownRet60 - uniMean : null;

        const flags: FilterFlags = {
          TREND: isBuy ? snap.close > snap.ema50 : snap.close < snap.ema50,
          VOLUME: snap.volumeRatio >= VOLUME_SURGE_MIN,
          RSI: isBuy ? snap.rsi14 <= RSI_OVERBOUGHT : snap.rsi14 >= RSI_OVERSOLD,
          RS: relStrength != null && (isBuy ? relStrength > 0 : relStrength < 0),
          STOPATR: snap.atr14 > 0 && stopDist / snap.atr14 >= MIN_STOP_ATR,
        };

        studyTrades.push({ trade: simulate(candles, i, setup, holdBars), flags });
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const bySetup = new Map<string, StudyTrade[]>();
  for (const st of studyTrades) {
    const arr = bySetup.get(st.trade.setupType) ?? [];
    arr.push(st);
    bySetup.set(st.trade.setupType, arr);
  }

  const md: string[] = [];
  md.push("# Quality-Filter Study — setup detectors over daily candles");
  md.push("");
  md.push(`Generated: ${new Date().toISOString()} | args: --days ${days} --holdBars ${holdBars}${rMultiple ? ` --rMultiple ${rMultiple}` : ""}${only ? ` --only ${only}` : ""}`);
  md.push(`Cost: ${COST_RATE_PER_SIDE * 100}%/side. Simulation identical to backtest_setups.ts (honest fills, stop-first tie-break).`);
  md.push("");
  md.push("Filters (all computed from bars <= signal bar only):");
  md.push("- **TREND** — close > EMA50 (longs) / close < EMA50 (shorts)");
  md.push(`- **VOLUME** — signal-bar volume >= ${VOLUME_SURGE_MIN}x prior-20-bar average`);
  md.push(`- **RSI** — reject RSI14 > ${RSI_OVERBOUGHT} longs / RSI14 < ${RSI_OVERSOLD} shorts`);
  md.push(`- **RS** — ${RS_LOOKBACK}-bar return minus equal-weight universe mean (same date); > 0 longs, < 0 shorts`);
  md.push(`- **STOPATR** — |entry - stop| / ATR14 >= ${MIN_STOP_ATR}`);
  md.push("");
  md.push("`expectancyPct` = avg net return per **filled** trade (timeouts included, no-fills excluded).");
  md.push("`winRatePct` = wins/(wins+losses), ignores timeouts. `retention` = signals kept vs baseline.");
  md.push("Note: filters gate the baseline signal stream post-hoc; live cooldown sequencing after a rejected signal may differ slightly.");
  md.push("");

  const setupOrder = [...bySetup.entries()].sort((a, b) => b[1].length - a[1].length);
  const singleMasks = FILTER_KEYS.map((_, b) => 1 << b);
  const allMask = (1 << FILTER_KEYS.length) - 1;

  for (const [setupType, sts] of setupOrder) {
    const baselineSignals = sts.length;
    const configs: ConfigStats[] = [];
    for (const mask of [0, ...singleMasks, allMask]) {
      const kept = sts.filter((st) => passesMask(st.flags, mask)).map((st) => st.trade);
      configs.push(statsFor(mask === 0 ? "baseline" : mask === allMask ? "ALL 5 combined" : maskName(mask), kept, baselineSignals));
    }

    // Full 2^5 sweep for ranked combos (min filled-trade floor to avoid noise-mining)
    const sweep: ConfigStats[] = [];
    for (let mask = 1; mask <= allMask; mask++) {
      const kept = sts.filter((st) => passesMask(st.flags, mask)).map((st) => st.trade);
      const s = statsFor(maskName(mask), kept, baselineSignals);
      if (s.filled >= MIN_FILLED_FOR_SWEEP) sweep.push(s);
    }
    sweep.sort((a, b) => (b.expectancyPct ?? -Infinity) - (a.expectancyPct ?? -Infinity));

    console.log(`\n=== ${setupType} (${baselineSignals} baseline signals) ===`);
    console.table(configs);

    md.push(`## ${setupType}`);
    md.push("");
    md.push("| config | signals | retention | filled | wins | losses | timeouts | noFills | winRate% | expectancy% |");
    md.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const c of configs) {
      md.push(`| ${c.config} | ${c.signals} | ${c.retentionPct}% | ${c.filled} | ${c.wins} | ${c.losses} | ${c.timeouts} | ${c.noFills} | ${c.winRatePct ?? "—"} | ${c.expectancyPct ?? "—"} |`);
    }
    md.push("");
    md.push(`Top filter combinations by expectancy (>= ${MIN_FILLED_FOR_SWEEP} filled trades):`);
    md.push("");
    md.push("| combo | signals | retention | filled | winRate% | expectancy% |");
    md.push("|---|---|---|---|---|---|");
    for (const c of sweep.slice(0, 5)) {
      md.push(`| ${c.config} | ${c.signals} | ${c.retentionPct}% | ${c.filled} | ${c.winRatePct ?? "—"} | ${c.expectancyPct ?? "—"} |`);
    }
    if (sweep.length === 0) md.push(`| _no combo retained >= ${MIN_FILLED_FOR_SWEEP} filled trades_ | | | | | |`);
    md.push("");
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.resolve(__dirname, "../../.backtest_filters.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log(`\nWrote ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Filter study failed:", err);
  process.exit(1);
});
