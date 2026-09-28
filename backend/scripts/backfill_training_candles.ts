/**
 * Historical daily-candle backfill for ranker training.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────────
 * `extract_training_data.ts` (the learned ranker's trainer) reads 420 days of
 * daily candles out of the `candles` table. That table is only ever filled by
 * the live Upstox pipeline, so on a fresh/portable install it is empty and
 * training has nothing to learn from. The checked-in
 * `backend/data/ranker_train.jsonl` is a stale 500-row artifact that is 31
 * features wide against a 32-feature serving contract, so `train_ranker.py`
 * correctly refuses it.
 *
 * The Upstox credentials in .env are placeholders (the "API key" is a UUID and
 * the secret is 10 chars), so the Upstox historical endpoint cannot be used.
 * Yahoo Finance needs no credentials, is already a backend dependency, and is
 * already trusted in this codebase for ^NSEI (see analysis/divergence_engine.ts).
 * So daily OHLCV is sourced from Yahoo and written under the SAME
 * `instrumentKey` values the rest of the pipeline uses (NSE_EQ|<ISIN>), keeping
 * the extractor's key→symbol mapping and the live path identical.
 *
 * Yahoo tickers are `<SYMBOL>.NS` for NSE equities and `^NSEI` for the index.
 *
 * Resumable: symbols that already have at least `--minBars` daily rows are
 * skipped, so an interrupted run can simply be re-invoked.
 *
 * Run: npx tsx scripts/backfill_training_candles.ts [--days 500] [--minBars 200]
 */
import YahooFinance from "yahoo-finance2";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/src";
import { candlesTable } from "../db/src/schema/candles";
import { NSE_UNIVERSE } from "../src/analysis/stock_scanner";

const yf = new YahooFinance();

/** Must match the extractor's NIFTY_KEY so RS-vs-Nifty is reconstructed. */
const NIFTY_KEY = "NSE_INDEX|Nifty 50";
const NIFTY_YAHOO = "^NSEI";

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Yahoo ticker ≠ our `symbol` when NSE renamed a listing.
 * Zomato Ltd renamed to Eternal Ltd (2025); our universe still carries the old
 * symbol/ISIN, so map it explicitly rather than silently dropping a name.
 */
const YAHOO_TICKER_ALIAS: Record<string, string> = {
  ZOMATO: "ETERNAL",
};

/**
 * Symbols with no Yahoo NSE coverage at all (verified by probe, not guessed).
 * TATAMOTORS has no ticker under any variant and MCDOWELL-N (McDonald's India)
 * is absent from Yahoo's NSE set. The extractor already skips instruments with
 * too few bars, so leaving these unfilled just removes them from the training
 * universe instead of poisoning it with fabricated candles.
 */
const NO_YAHOO_COVERAGE = new Set(["TATAMOTORS", "MCDOWELL-N"]);

interface Bar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchDailyBars(yahooSymbol: string, since: Date): Promise<Bar[]> {
  const res = (await yf.chart(yahooSymbol, {
    period1: since,
    interval: "1d",
  })) as any;
  const quotes: any[] = res?.quotes ?? [];
  const out: Bar[] = [];
  for (const q of quotes) {
    // Yahoo pads holidays/halts with nulls; a bar with no close is not a bar.
    if (q?.close == null || q?.open == null || q?.high == null || q?.low == null) continue;
    const d = new Date(q.date);
    if (Number.isNaN(d.getTime())) continue;
    out.push({
      timestamp: d,
      open: Number(q.open),
      high: Number(q.high),
      low: Number(q.low),
      close: Number(q.close),
      // ^NSEI has no volume; the extractor never reads volume, but the column
      // is NOT NULL, so store 0 rather than failing the insert.
      volume: q.volume == null ? 0 : Math.round(Number(q.volume)),
    });
  }
  out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return out;
}

async function existingBarCount(instrumentKey: string, since: Date): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(candlesTable)
    .where(and(eq(candlesTable.instrumentKey, instrumentKey), eq(candlesTable.interval, "day"), gte(candlesTable.timestamp, since)));
  return Number(r[0]?.n ?? 0);
}

async function upsertBars(instrumentKey: string, bars: Bar[]): Promise<number> {
  if (bars.length === 0) return 0;
  await db
    .insert(candlesTable)
    .values(
      bars.map((b) => ({
        instrumentKey,
        interval: "day" as const,
        timestamp: b.timestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
    )
    .onConflictDoUpdate({
      target: [candlesTable.instrumentKey, candlesTable.interval, candlesTable.timestamp],
      set: {
        open: sql`EXCLUDED.open`,
        high: sql`EXCLUDED.high`,
        low: sql`EXCLUDED.low`,
        close: sql`EXCLUDED.close`,
        volume: sql`EXCLUDED.volume`,
        updatedAt: new Date(),
      },
    });
  return bars.length;
}

async function backfillOne(
  instrumentKey: string,
  yahooSymbol: string,
  since: Date,
  minBars: number,
  label: string,
): Promise<number> {
  const have = await existingBarCount(instrumentKey, since);
  if (have >= minBars) {
    console.log(`  skip  ${label.padEnd(14)} ${yahooSymbol.padEnd(16)} already ${have} bars`);
    return 0;
  }

  // Yahoo throttles aggressive bursts; back off and retry rather than failing
  // the run. 3 attempts with linear backoff.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const bars = await fetchDailyBars(yahooSymbol, since);
      const n = await upsertBars(instrumentKey, bars);
      console.log(`  ok    ${label.padEnd(14)} ${yahooSymbol.padEnd(16)} +${n} bars (had ${have})`);
      await sleep(250);
      return n;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 80);
      if (attempt === 3) {
        console.log(`  FAIL  ${label.padEnd(14)} ${yahooSymbol.padEnd(16)} ${msg}`);
        return 0;
      }
      console.log(`  retry ${label.padEnd(14)} ${yahooSymbol.padEnd(16)} attempt ${attempt}: ${msg}`);
      await sleep(1000 * attempt * 2);
    }
  }
  return 0;
}

async function main() {
  const days = argNum("days", 500);
  const minBars = argNum("minBars", 200);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(`Backfilling daily candles since ${since.toISOString().slice(0, 10)}`);
  console.log(`Universe: ${NSE_UNIVERSE.length} equities + 1 index (${NIFTY_KEY})\n`);

  let totalBars = 0;
  let failed = 0;

  // Index first: the extractor needs Nifty to reconstruct point-in-time
  // RS-vs-Nifty. Without it every stock's rsVsNifty60d falls back to 1.0.
  totalBars += await backfillOne(NIFTY_KEY, NIFTY_YAHOO, since, minBars, "NIFTY 50");

  let i = 0;
  for (const s of NSE_UNIVERSE) {
    i++;
    if (NO_YAHOO_COVERAGE.has(s.symbol)) {
      console.log(`  n/a   ${s.symbol.padEnd(14)} no Yahoo NSE coverage (excluded from training universe)`);
      continue;
    }
    if (i % 10 === 0 || i === NSE_UNIVERSE.length) {
      console.log(`  ... ${i}/${NSE_UNIVERSE.length} processed, ${totalBars} bars written`);
    }
    const ticker = YAHOO_TICKER_ALIAS[s.symbol] ?? s.symbol;
    const n = await backfillOne(s.key, `${ticker}.NS`, since, minBars, s.symbol);
    totalBars += n;
    if (n === 0) {
      // distinguish "skipped" from "failed" by re-counting
      const have = await existingBarCount(s.key, since);
      if (have < minBars) failed++;
    }
  }

  console.log(`\nDone. ${totalBars} bars written, ${failed} symbols could not be filled.`);
  console.log(`Excluded for lack of any Yahoo coverage: ${[...NO_YAHOO_COVERAGE].join(", ")}`);
  console.log("Next: npm run ranker:extract && npm run ranker:train:only");
  process.exit(0);
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
