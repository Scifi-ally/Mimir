import { logger } from "../lib/logger";
import { tickDistribution } from "./tick_distribution";
import { getISTDateStr } from "../lib/ist-time";
import fs from "fs/promises";
import path from "path";

const ARCHIVE_DIR = path.resolve(process.cwd(), "data/ticks");

// tickDistribution only retains ~5 min of history, so a single nightly run
// captured almost nothing. Instead we flush incrementally during market hours
// (scheduler calls this every few minutes) and once more post-market. Each
// Deduplicate observations, not timestamps: the feed accepts late ticks and
// several different observations can share a millisecond. Restore recent keys
// from the append-only archive on restart. Unsequenced identical observations
// cannot be distinguished; they are conservatively stored once.
let flushStateDate = "";
const archivedKeys = new Map<string, number>();
let flushInFlight: Promise<void> | null = null;

function observationKey(symbol: string, tick: { timestamp: number; sequence?: number }): string {
  return tick.sequence != null
    ? `${symbol}:${tick.timestamp}:${tick.sequence}`
    : `${symbol}:${JSON.stringify(tick)}`;
}

async function appendRecentTicks(): Promise<void> {
  const todayIST = getISTDateStr();
  const cutoff = Date.now() - 10 * 60_000;
  const archiveFile = path.join(ARCHIVE_DIR, `ticks_${todayIST}.jsonl`);
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  if (flushStateDate !== todayIST) {
    archivedKeys.clear();
    let archiveHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      archiveHandle = await fs.open(archiveFile, "r");
      for await (const line of archiveHandle.readLines()) {
        if (!line.trim()) continue;
        // A partial/corrupt record is an error, not permission to append a
        // duplicate replacement. Retain the archive for repair.
        const row = JSON.parse(line);
        if (typeof row.symbol !== "string" || !Array.isArray(row.tickData)) throw new Error("Invalid tick archive record");
        for (const tick of row.tickData) {
          if (Number.isFinite(tick.timestamp) && tick.timestamp >= cutoff) {
            archivedKeys.set(observationKey(row.symbol, tick), tick.timestamp);
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    } finally {
      await archiveHandle?.close();
    }
    flushStateDate = todayIST;
  }
  for (const [key, timestamp] of archivedKeys) if (timestamp < cutoff) archivedKeys.delete(key);
  let symbolsArchived = 0;
  for (const snapshot of tickDistribution.getAllCachedTicks()) {
    const symbol = snapshot.symbol;
    const newKeys = new Map<string, number>();
    const history = tickDistribution.getTickHistory(symbol).filter((tick) => {
      if (!Number.isFinite(tick.timestamp) || tick.timestamp < cutoff || getISTDateStr(new Date(tick.timestamp)) !== todayIST) return false;
      const key = observationKey(symbol, tick);
      if (archivedKeys.has(key) || newKeys.has(key)) return false;
      newKeys.set(key, tick.timestamp);
      return true;
    });
    if (!history.length) continue;
    await fs.appendFile(archiveFile, JSON.stringify({ symbol, date: todayIST, tickData: history }) + "\n", "utf8");
    for (const [key, timestamp] of newKeys) archivedKeys.set(key, timestamp);
    symbolsArchived++;
  }
  if (symbolsArchived) logger.info(`Archived new ticks for ${symbolsArchived} symbols to ${archiveFile}.`);
}

export async function archiveDailyTicks(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = appendRecentTicks()
    .catch((err) => { logger.error({ err }, "Failed to archive daily ticks"); })
    .finally(() => { flushInFlight = null; });
  return flushInFlight;
}
