import { logger } from "../lib/logger";
import { tickDistribution } from "./tick_distribution";
import { getISTDateStr } from "../lib/ist-time";
import fs from "fs/promises";
import path from "path";

const ARCHIVE_DIR = path.resolve(process.cwd(), "data/ticks");

// tickDistribution only retains ~5 min of history, so a single nightly run
// captured almost nothing. Instead we flush incrementally during market hours
// (scheduler calls this every few minutes) and once more post-market. Each
// flush appends only ticks newer than the last flush per symbol, so re-runs
// never duplicate rows. Rows: { symbol, date, tickData: [...new ticks] }.
// ponytail: in-memory watermark — a restart mid-day may re-append up to 5 min
// of ticks; persist the watermark if exact-once matters.
let flushStateDate = "";
const lastFlushedTs = new Map<string, number>();

export async function archiveDailyTicks(): Promise<void> {
  const todayIST = getISTDateStr();

  try {
    if (flushStateDate !== todayIST) {
      flushStateDate = todayIST;
      lastFlushedTs.clear();
    }

    const allTicks = tickDistribution.getAllCachedTicks();
    if (allTicks.length === 0) return;

    // Ensure archive directory exists
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });

    let symbolsArchived = 0;
    const archiveFile = path.join(ARCHIVE_DIR, `ticks_${todayIST}.jsonl`);

    // We'll stream or batch write to avoid massive memory strings
    for (const snapshot of allTicks) {
      const symbol = snapshot.symbol;
      const watermark = lastFlushedTs.get(symbol) ?? 0;
      const history = tickDistribution
        .getTickHistory(symbol)
        .filter((t) => t.timestamp > watermark);
      if (history.length > 0) {
        const row = { symbol, date: todayIST, tickData: history };
        await fs.appendFile(archiveFile, JSON.stringify(row) + "\n", "utf8");
        lastFlushedTs.set(symbol, history[history.length - 1]!.timestamp);
        symbolsArchived++;
      }
    }

    if (symbolsArchived > 0) {
      logger.info(`Archived new ticks for ${symbolsArchived} symbols to ${archiveFile}.`);
    }
  } catch (err) {
    logger.error({ err }, "Failed to archive daily ticks");
  }
}
