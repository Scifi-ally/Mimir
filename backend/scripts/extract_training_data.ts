/**
 * Extract labelled training rows for the learned ranker from cached daily candles.
 *
 * Replays each instrument's daily history exactly like backtest_setups.ts:
 * at every bar (after warmup) run every non-disabled detector on the data
 * visible up to that bar, compute the SAME feature vector the live pipeline
 * computes (via computeFeatureVector), then walk forward under the honest-fill
 * model to label the trade WIN / LOSS. The feature vector is projected onto the
 * shared RANKER_FEATURE_KEYS contract so training and serving can never drift.
 *
 * Point-in-time correctness:
 *   - features use ONLY candles[0..i] (no look-ahead)
 *   - the label uses candles[i+1..i+holdBars] (the future), which is fine — it
 *     is the thing we are predicting, never fed back as a feature
 *   - RS vs Nifty is reconstructed from the Nifty series sliced to the same date
 *   - the 3 live-only features (regime/sector/market strength) are excluded by
 *     the RANKER_FEATURE_KEYS contract, so the stale in-memory globals that
 *     computeFeatureVector reads for them are harmless here
 *
 * Output: JSONL, one row per decided trade (NO_FILL rows are dropped — they
 * never became positions). Each row:
 *   { ts, symbol, setupType, direction, tradeType, features:[...], label, retPct }
 * where label = 1 only if the trade hit target1 before stop (a WIN), else 0.
 *
 * Run: npx tsx backend/scripts/extract_training_data.ts \
 *        [--days 420] [--holdBars 5] [--out data/ranker_train.jsonl]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { db, candlesTable } from "../db/src";
import { and, eq, gte, asc } from "drizzle-orm";
import {
  buildSnapshot,
  detectPullback,
  detectMomentum,
  detectEma9Reclaim,
  detectEma9Rejection,
  detectMacdCrossover,
  type OHLCV,
  type SetupCandidate,
  type TechnicalSnapshot,
} from "../src/analysis/technical";
import { NSE_UNIVERSE } from "../src/analysis/stock_scanner";
import { computeFeatureVector, toRankerFeatureArray } from "../src/analysis/feature_engine";
import { replayTrade, type ReplayResult } from "../src/analysis/trade_replay";
import { relativeStrength60, sectorRelativeStrength60 } from "../src/analysis/relative_strength";
import { DELIVERY_FEE_MODEL } from "../src/analysis/transaction_costs";
import { dailySessionDate, dailyAvailableAt } from "../src/analysis/daily_session";

// Only the detectors that actually produce live suggestions today. Keeping this
// in sync with the pipeline's enabled set (NEGATIVE_EXPECTANCY_SETUPS removes the
// rest) means the ranker learns on the same distribution it will rank at serve
// time — no training on setups that can never be emitted.
const DETECTORS = [
  detectPullback,
  detectMomentum,
  detectEma9Reclaim,
  detectEma9Rejection,
  detectMacdCrossover,
];

const WARMUP_BARS = 200;
const NIFTY_KEY = "NSE_INDEX|Nifty 50";
const VALIDATED_HOLD_BARS = 5;
const MIN_AVERAGE_TURNOVER_20D_INR = 50_000_000;
const MAX_NOTIONAL_TO_TURNOVER_20D = 0.001;
const STRATEGY_SCOPE_VERSION = "cash-long-5bar-20d-turnover-v1";

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

function argStr(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? dflt : dflt;
}

type Labeled = ReplayResult;

/** Honest-fill walk-forward, identical rules to backtest_setups.simulate(). */
function labelTrade(
  candles: OHLCV[],
  signalIdx: number,
  setup: SetupCandidate,
  holdBars: number,
): Labeled {
  return replayTrade(candles, signalIdx, setup, holdBars);
}

async function loadDaily(instrumentKey: string, since: Date): Promise<OHLCV[]> {
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
  const isEquity = instrumentKey !== NIFTY_KEY;
  const validRows = rows.filter((row) => {
    const { open, high, low, close, volume } = row;
    return [open, high, low, close, volume, row.timestamp.getTime()].every(Number.isFinite) &&
      low > 0 && high >= Math.max(open, low, close) && low <= Math.min(open, close) &&
      volume >= 0 && (!isEquity || volume > 0);
  });
  if (validRows.length !== rows.length) {
    console.warn(`Excluded ${rows.length - validRows.length} invalid${isEquity ? " or zero-volume" : ""} bars from ${instrumentKey}`);
  }
  const seen = new Set<string>();
  let ambiguousFrom = "9999-12-31";
  for (const row of validRows) {
    const date = dailySessionDate(row.timestamp.getTime());
    if (seen.has(date) && date < ambiguousFrom) ambiguousFrom = date;
    seen.add(date);
  }
  // Do not choose between conflicting vendor bars or silently count one
  // session twice. Preserve only the uncontested prefix for research.
  if (ambiguousFrom !== "9999-12-31") console.warn(`Excluded ${instrumentKey} history from duplicate session ${ambiguousFrom}`);
  return validRows.filter(r => dailySessionDate(r.timestamp.getTime()) < ambiguousFrom).map((r) => ({
    timestamp: r.timestamp.toISOString(),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}

/**
 * The canonical default output path, anchored to THIS module's directory
 * (backend/scripts/../data) so it lands in backend/data/ regardless of the
 * launching process's cwd. This MUST match train_ranker.py's default --data
 * (ai_service/../data), otherwise the node extractor and the python trainer
 * silently use different files.
 */
export function defaultTrainingDataPath(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "..", "data", "ranker_train.jsonl");
}

export interface ExtractResult {
  outPath: string;
  rows: number;
  wins: number;
  losses: number;
  timeouts: number;
  featureDim: number;
  instruments: number;
}

/**
 * Extract + label training rows and write them as JSONL. Importable so the
 * continuous-learning pipeline can run it IN-PROCESS (no tsx/subprocess, no
 * interpreter dependency in the portable install). Never calls process.exit —
 * callers decide control flow.
 */
export async function extractTrainingData(opts?: {
  days?: number;
  holdBars?: number;
  outPath?: string;
}): Promise<ExtractResult> {
  const days = opts?.days ?? 1900;
  const holdBars = opts?.holdBars ?? 5;
  if (holdBars !== VALIDATED_HOLD_BARS) {
    throw new Error(`Ranker training is validated only for ${VALIDATED_HOLD_BARS}-session outcomes`);
  }
  const outPath = opts?.outPath ?? defaultTrainingDataPath();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const keyToMeta = new Map(NSE_UNIVERSE.map((s) => [s.key, { symbol: s.symbol, sector: s.sector as string }]));

  // Nifty series for point-in-time RS reconstruction (optional — defaults to 1.0).
  const niftyCandles = await loadDaily(NIFTY_KEY, since);

  const instruments = await db
    .selectDistinct({ instrumentKey: candlesTable.instrumentKey })
    .from(candlesTable)
    .where(and(eq(candlesTable.interval, "day"), gte(candlesTable.timestamp, since)));

  if (instruments.length === 0) {
    return { outPath, rows: 0, wins: 0, losses: 0, timeouts: 0, featureDim: 0, instruments: 0 };
  }

  const lines: string[] = [];
  let wins = 0;
  let losses = 0;
  let timeouts = 0;

  const histories = new Map<string, OHLCV[]>();
  const sectors = new Map<string, string>();
  for (const { instrumentKey } of instruments) {
    const meta = keyToMeta.get(instrumentKey);
    if (!meta) continue;
    histories.set(meta.symbol, await loadDaily(instrumentKey, since));
    sectors.set(meta.symbol, meta.sector);
  }

  for (const { instrumentKey } of instruments) {
    const meta = keyToMeta.get(instrumentKey);
    if (!meta) continue; // not a tracked equity (indices, etc.)
    const candles = histories.get(meta.symbol)!;
    if (candles.length < WARMUP_BARS + holdBars) continue;

    const lastSignalIdx = new Map<string, number>();

    for (let i = WARMUP_BARS; i < candles.length - holdBars; i++) {
      const visible = candles.slice(0, i + 1);
      let snap: TechnicalSnapshot | null = null;
      try {
        snap = buildSnapshot(visible);
      } catch { /* edge-case data */ }
      if (!snap) continue;

      const rs60 = relativeStrength60(visible, niftyCandles);
      const sectorRs = sectorRelativeStrength60(meta.symbol, meta.sector, visible, histories, sectors);
      if (rs60 === null || sectorRs === null) continue;
      // The legacy table stores no source or publication timestamp, so even
      // nonzero values cannot be reconstructed as point-in-time features.
      const historicalFiiDiiFlowLag = null;

      for (const detect of DETECTORS) {
        let setup: SetupCandidate | null = null;
        try {
          setup = detect(visible, snap);
        } catch { /* detector threw */ }
        if (!setup) continue;
        // This corpus contains CASH equities, not borrowable stocks/futures.
        // A five-session naked short is not an executable delivery position.
        if (setup.direction === "SELL") continue;
        const averageTurnover = visible.slice(-20).reduce((sum, c) => sum + c.close * c.volume, 0) / 20;
        if (averageTurnover < MIN_AVERAGE_TURNOVER_20D_INR ||
            100_000 / averageTurnover > MAX_NOTIONAL_TO_TURNOVER_20D) continue;

        // Per-setup cooldown so a persistent condition doesn't flood identical rows.
        const prev = lastSignalIdx.get(setup.setupType);
        if (prev != null && i - prev < holdBars) continue;
        lastSignalIdx.set(setup.setupType, i);

        const labeled = labelTrade(candles, i, setup, holdBars);
        if (!["WIN", "LOSS", "TIMEOUT"].includes(labeled.outcome)) continue; // never became a position

        const fv = computeFeatureVector(
          meta.symbol,
          meta.sector,
          visible,
          snap,
          rs60,
          sectorRs,
          setup.riskReward,
          undefined, // bidAskImbalance
          undefined, // optionsOiChangeRate
          false, // rankerIncomplete
          historicalFiiDiiFlowLag
        );
        const features = toRankerFeatureArray(fv);

        // Label: 1 = target1 hit before stop; every other resolved outcome,
        // including TIMEOUT, is 0. This keeps the supervised target aligned with
        // the serving contract: calibrated P(target1 before stop). Timeout return
        // remains available in retPct for separate expectancy analysis.
        const label = labeled.outcome === "WIN" ? 1 : 0;
        if (labeled.outcome === "WIN") wins++;
        else if (labeled.outcome === "LOSS") losses++;
        else if (labeled.outcome === "TIMEOUT") timeouts++;

        lines.push(
          JSON.stringify({
            ts: dailyAvailableAt(candles[i]!.timestamp),
            fillTs: labeled.fillTs,
            outcome: labeled.outcome,
            replayVersion: "limit-gap-v2",
            feeModel: DELIVERY_FEE_MODEL,
            notionalInr: 100_000,
            slippageBpsPerSide: 5,
            horizonBars: holdBars,
            strategyScopeVersion: STRATEGY_SCOPE_VERSION,
            averageTurnover20dInr: averageTurnover,
            resolutionTs: labeled.resolutionTs,
            symbol: meta.symbol,
            setupType: setup.setupType,
            direction: setup.direction,
            features,
            label,
            retPct: Math.round(labeled.retPct * 1000) / 1000,
          }),
        );
      }
    }
  }

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");

  const featureDim = lines.length ? (JSON.parse(lines[0]!).features as number[]).length : 0;
  return { outPath, rows: lines.length, wins, losses, timeouts, featureDim, instruments: instruments.length };
}

async function main() {
  const days = argNum("days", 1900);
  const holdBars = argNum("holdBars", 5);
  // An explicit --out overrides the anchored default: absolute is used as-is,
  // relative resolves against cwd for interactive runs.
  const outArg = argStr("out", "");
  const outPath = outArg
    ? (path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg))
    : defaultTrainingDataPath();

  const r = await extractTrainingData({ days, holdBars, outPath });
  if (r.instruments === 0) {
    console.log("No daily candles in DB. Run a scan first to populate candlesTable.");
    process.exit(0);
  }
  console.log(`\nWrote ${r.rows} labelled rows to ${r.outPath}`);
  console.log(`Hard outcomes: ${r.wins} WIN / ${r.losses} LOSS / ${r.timeouts} TIMEOUT (target-hit rate ${r.rows ? ((r.wins / r.rows) * 100).toFixed(1) : "—"}%)`);
  console.log(`Feature dim: ${r.featureDim}`);
  process.exit(0);
}

// Only run the CLI wrapper when executed directly (tsx/node scripts/…), NEVER on
// import. The continuous-learning pipeline imports extractTrainingData() and must
// not trigger main()'s process.exit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("Extraction failed:", err);
    process.exit(1);
  });
}
