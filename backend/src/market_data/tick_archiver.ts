import { logger } from "../lib/logger";
import { tickDistribution } from "./tick_distribution";
import { getISTDateStr } from "../lib/ist-time";
import fs from "fs/promises";
import path from "path";

const ARCHIVE_DIR = path.resolve(process.cwd(), "data/ticks");

export async function archiveDailyTicks(): Promise<void> {
  const todayIST = getISTDateStr();
  logger.info({ date: todayIST }, "Starting daily tick archive process");

  try {
    const allTicks = tickDistribution.getAllCachedTicks();
    if (allTicks.length === 0) {
      logger.info("No ticks in cache to archive.");
      return;
    }

    // Ensure archive directory exists
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });

    let symbolsArchived = 0;
    const archiveFile = path.join(ARCHIVE_DIR, `ticks_${todayIST}.jsonl`);

    // We'll stream or batch write to avoid massive memory strings
    for (const snapshot of allTicks) {
       const symbol = snapshot.symbol;
       const history = tickDistribution.getTickHistory(symbol);
       if (history && history.length > 0) {
           const row = { symbol, date: todayIST, tickData: history };
           await fs.appendFile(archiveFile, JSON.stringify(row) + "\n", "utf8");
           symbolsArchived++;
       }
    }

    logger.info(`Successfully archived ticks for ${symbolsArchived} symbols to ${archiveFile}.`);
  } catch (err) {
    logger.error({ err }, "Failed to archive daily ticks");
  }
}
