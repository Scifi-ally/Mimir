/**
 * Backtest setup detectors over cached daily candles in candlesTable.
 *
 * Replays each stock's daily history: at every bar (after a 55-bar warmup)
 * runs all setup detectors on the data visible up to that bar, then walks
 * forward to see whether entry filled and whether stop or target hit first.
 * Uses the same honest fill rules as accuracy_tracker:
 *   - entry must be touched by a later bar, else trade never existed
 *   - on a bar where both stop and target are inside the range, stop wins
 *   - flat transaction costs on both legs
 *
 * Run: npx tsx backend/scripts/backtest_setups.ts [--days 365] [--holdBars 5] [--rMultiple 2] [--only SETUP_TYPE]
 *   --rMultiple overrides every setup's target to entry + R*risk (sweep tool)
 *   --only restricts to one setupType
 */
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

import { replayTrade } from "../src/analysis/trade_replay";

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

const WARMUP_BARS = 200;

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

/** Walk forward from signal bar; honest fill + pessimistic intrabar tie-break. */
function simulate(candles: OHLCV[], signalIdx: number, setup: SetupCandidate, holdBars: number): TradeResult {
  const replay = replayTrade(candles, signalIdx, setup, holdBars);
  return { setupType: setup.setupType, direction: setup.direction,
    outcome: ["WIN", "LOSS", "TIMEOUT"].includes(replay.outcome)
      ? replay.outcome as "WIN" | "LOSS" | "TIMEOUT" : "NO_FILL",
    returnPct: replay.retPct };

}

async function main() {
  const days = argNum("days", 365);
  const holdBars = argNum("holdBars", 5);
  const rMultiple = argNum("rMultiple", 0); // 0 = use detector's own target
  const only = argStr("only");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const instruments = await db
    .selectDistinct({ instrumentKey: candlesTable.instrumentKey })
    .from(candlesTable)
    .where(and(eq(candlesTable.interval, "day"), gte(candlesTable.timestamp, since)));

  console.log(`Backtesting ${instruments.length} instruments, ${days}d lookback, ${holdBars}-bar hold; current cash-delivery tariff, INR 100000 notional, 5bps slippage per side. Shorts are hypothetical and cannot establish cash-delivery profitability.\n`);
  if (instruments.length === 0) {
    console.log("No daily candles in DB. Run a scan first to populate candlesTable.");
    process.exit(0);
  }

  const trades: TradeResult[] = [];

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

    // Per-symbol cooldown so one persistent condition doesn't spam signals
    const lastSignalIdx = new Map<string, number>();

    for (let i = WARMUP_BARS; i < candles.length - holdBars; i++) {
      const visible = candles.slice(0, i + 1);
      const snap = buildSnapshot(visible);
      if (!snap) continue;

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
        trades.push(simulate(candles, i, setup, holdBars));
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const bySetup = new Map<string, TradeResult[]>();
  for (const t of trades) {
    const arr = bySetup.get(t.setupType) ?? [];
    arr.push(t);
    bySetup.set(t.setupType, arr);
  }

  const rows = [...bySetup.entries()].map(([setupType, ts]) => {
    const wins = ts.filter((t) => t.outcome === "WIN").length;
    const losses = ts.filter((t) => t.outcome === "LOSS").length;
    const timeouts = ts.filter((t) => t.outcome === "TIMEOUT").length;
    const noFills = ts.filter((t) => t.outcome === "NO_FILL").length;
    const decided = ts.filter((t) => t.outcome !== "NO_FILL");
    const avgReturn = decided.length ? decided.reduce((a, t) => a + t.returnPct, 0) / decided.length : 0;
    return {
      setup: setupType,
      signals: ts.length,
      wins, losses, timeouts, noFills,
      winRatePct: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
      expectancyPct: Math.round(avgReturn * 1000) / 1000,
    };
  }).sort((a, b) => (b.expectancyPct ?? 0) - (a.expectancyPct ?? 0));

  console.table(rows);
  console.log("\nwinRatePct = wins/(wins+losses), ignores timeouts. expectancyPct = avg net return per filled trade.");
  console.log("Negative expectancy setups are net losers under honest fills — candidates for removal.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
