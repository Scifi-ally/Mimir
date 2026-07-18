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
 * where label = 1 if the trade hit target1 before stop (a WIN), else 0.
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

const COST_RATE_PER_SIDE = 0.0005; // keep in sync with accuracy_tracker + backtest_setups
const WARMUP_BARS = 60;
const NIFTY_KEY = "NSE_INDEX|Nifty 50";

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

function argStr(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? dflt : dflt;
}

interface Labeled {
  outcome: "WIN" | "LOSS" | "NO_FILL" | "TIMEOUT";
  retPct: number; // net of costs, 0 for NO_FILL
}

/** Honest-fill walk-forward, identical rules to backtest_setups.simulate(). */
function labelTrade(
  candles: OHLCV[],
  signalIdx: number,
  setup: SetupCandidate,
  holdBars: number,
): Labeled {
  const { direction, entryPrice, stopLoss, target1 } = setup;
  const isBuy = direction === "BUY";
  let filled = false;

  for (let i = signalIdx + 1; i < Math.min(signalIdx + 1 + holdBars, candles.length); i++) {
    const bar = candles[i]!;

    if (!filled) {
      const touched = isBuy ? bar.low <= entryPrice : bar.high >= entryPrice;
      if (!touched) continue;
      const gappedPastTarget = isBuy ? bar.open >= target1 : bar.open <= target1;
      if (gappedPastTarget) return { outcome: "NO_FILL", retPct: 0 };
      filled = true;
    }

    const stopHit = isBuy ? bar.low <= stopLoss : bar.high >= stopLoss;
    const targetHit = isBuy ? bar.high >= target1 : bar.low <= target1;

    if (stopHit) {
      const gross = isBuy ? (stopLoss - entryPrice) / entryPrice : (entryPrice - stopLoss) / entryPrice;
      return { outcome: "LOSS", retPct: (gross - 2 * COST_RATE_PER_SIDE) * 100 };
    }
    if (targetHit) {
      const gross = isBuy ? (target1 - entryPrice) / entryPrice : (entryPrice - target1) / entryPrice;
      return { outcome: "WIN", retPct: (gross - 2 * COST_RATE_PER_SIDE) * 100 };
    }
  }

  if (!filled) return { outcome: "NO_FILL", retPct: 0 };

  const lastIdx = Math.min(signalIdx + holdBars, candles.length - 1);
  const exit = candles[lastIdx]!.close;
  const gross = isBuy ? (exit - entryPrice) / entryPrice : (entryPrice - exit) / entryPrice;
  return { outcome: "TIMEOUT", retPct: (gross - 2 * COST_RATE_PER_SIDE) * 100 };
}

/** RS vs Nifty over the trailing 60 bars, reconstructed from the visible window. */
function computeRS60PIT(stockVisible: OHLCV[], niftyByTs: Map<number, number>, asOf: number): number {
  const len = stockVisible.length;
  if (len < 62) return 1.0;
  const stockNow = stockVisible[len - 1]!.close;
  const stock60Ago = stockVisible[len - 61]!.close;
  // Find the Nifty close at asOf and ~60 bars earlier by timestamp.
  const niftyNow = niftyByTs.get(asOf);
  const ago60 = stockVisible[len - 61]!.timestamp;
  const niftyAgo = niftyByTs.get(new Date(ago60).getTime());
  if (!niftyNow || !niftyAgo || stock60Ago === 0 || niftyAgo === 0) return 1.0;
  const stockRet = stockNow / stock60Ago;
  const niftyRet = niftyNow / niftyAgo;
  if (niftyRet === 0) return 1.0;
  return Math.round((stockRet / niftyRet) * 1000) / 1000;
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
  return rows.map((r) => ({
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
  const days = opts?.days ?? 420;
  const holdBars = opts?.holdBars ?? 5;
  const outPath = opts?.outPath ?? defaultTrainingDataPath();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const keyToMeta = new Map(NSE_UNIVERSE.map((s) => [s.key, { symbol: s.symbol, sector: s.sector as string }]));

  // Nifty series for point-in-time RS reconstruction (optional — defaults to 1.0).
  const niftyCandles = await loadDaily(NIFTY_KEY, since);
  const niftyByTs = new Map<number, number>();
  for (const c of niftyCandles) niftyByTs.set(new Date(c.timestamp).getTime(), c.close);

  const instruments = await db
    .selectDistinct({ instrumentKey: candlesTable.instrumentKey })
    .from(candlesTable)
    .where(and(eq(candlesTable.interval, "day"), gte(candlesTable.timestamp, since)));

  if (instruments.length === 0) {
    return { outPath, rows: 0, wins: 0, losses: 0, featureDim: 0, instruments: 0 };
  }

  const lines: string[] = [];
  let wins = 0;
  let losses = 0;

  for (const { instrumentKey } of instruments) {
    const meta = keyToMeta.get(instrumentKey);
    if (!meta) continue; // not a tracked equity (indices, etc.)
    const candles = await loadDaily(instrumentKey, since);
    if (candles.length < WARMUP_BARS + holdBars) continue;

    const lastSignalIdx = new Map<string, number>();

    for (let i = WARMUP_BARS; i < candles.length - holdBars; i++) {
      const visible = candles.slice(0, i + 1);
      let snap: TechnicalSnapshot | null = null;
      try {
        snap = buildSnapshot(visible);
      } catch { /* edge-case data */ }
      if (!snap) continue;

      const asOf = new Date(candles[i]!.timestamp).getTime();
      const rs60 = computeRS60PIT(visible, niftyByTs, asOf);

      for (const detect of DETECTORS) {
        let setup: SetupCandidate | null = null;
        try {
          setup = detect(visible, snap);
        } catch { /* detector threw */ }
        if (!setup) continue;

        // Per-setup cooldown so a persistent condition doesn't flood identical rows.
        const prev = lastSignalIdx.get(setup.setupType);
        if (prev != null && i - prev < holdBars) continue;
        lastSignalIdx.set(setup.setupType, i);

        const labeled = labelTrade(candles, i, setup, holdBars);
        if (labeled.outcome === "NO_FILL") continue; // never became a position

        const fv = computeFeatureVector(
          meta.symbol,
          meta.sector,
          visible,
          snap,
          rs60,
          1.0, // sector RS: scanner's own fallback when sector series unavailable
          setup.riskReward,
        );
        const features = toRankerFeatureArray(fv);

        // Label: 1 = target hit before stop. TIMEOUT is labelled by realized sign
        // (a timed-out trade that drifted positive net of costs is a soft win),
        // which teaches the ranker to prefer setups that at least don't bleed.
        const label = labeled.outcome === "WIN" ? 1 : labeled.outcome === "LOSS" ? 0 : labeled.retPct > 0 ? 1 : 0;
        if (labeled.outcome === "WIN") wins++;
        else if (labeled.outcome === "LOSS") losses++;

        lines.push(
          JSON.stringify({
            ts: candles[i]!.timestamp,
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
  return { outPath, rows: lines.length, wins, losses, featureDim, instruments: instruments.length };
}

async function main() {
  const days = argNum("days", 420);
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
  console.log(`Hard outcomes: ${r.wins} WIN / ${r.losses} LOSS (win rate ${r.wins + r.losses ? ((r.wins / (r.wins + r.losses)) * 100).toFixed(1) : "—"}%)`);
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
