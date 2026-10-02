import fs from "node:fs";
import { sql } from "drizzle-orm";
import { db, candlesTable, pool } from "../db/src";
import { createUpstoxClient } from "../src/lib/upstox-client";
import { getAccessToken } from "../src/upstox/auth";
import type { SplitAdjustment } from "../src/market_data/corporate_actions";
import { mapAdjustedCandles } from "./backfill_daily_candles_lib";

const START_DATE = "2019-01-01";
const INTERVAL = "day" as const;
const CHUNK_DAYS = 365;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateChunks(start: string, end: string): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  const finish = new Date(`${end}T00:00:00Z`);
  while (cursor < finish) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS);
    if (chunkEnd > finish) chunkEnd.setTime(finish.getTime());
    chunks.push([isoDate(cursor), isoDate(chunkEnd)]);
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

async function main(): Promise<void> {
  const instrumentKeys = (arg("instrumentKeys") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (instrumentKeys.length === 0) {
    throw new Error("Pass at least one --instrumentKeys value (comma-separated Upstox instrument keys).");
  }
  const token = getAccessToken("data") ?? getAccessToken("trading");
  if (!token) throw new Error("No Upstox access token available; refusing to fabricate candle data.");

  const endDate = arg("endDate") ?? isoDate(new Date());
  const adjustmentsPath = arg("adjustmentsFile");
  const adjustments: SplitAdjustment[] = adjustmentsPath
    ? JSON.parse(fs.readFileSync(adjustmentsPath, "utf8")) as SplitAdjustment[]
    : [];
  const client = createUpstoxClient({ cacheTimeMs: 24 * 60 * 60 * 1000 });
  let upserted = 0;

  for (const instrumentKey of instrumentKeys) {
    for (const [fromDate, toDate] of dateChunks(START_DATE, endDate)) {
      const raw = await client.fetchHistoricalCandles(instrumentKey, INTERVAL, toDate, fromDate, token);
      const rows = mapAdjustedCandles(instrumentKey, raw, adjustments);
      for (let offset = 0; offset < rows.length; offset += 500) {
        const batch = rows.slice(offset, offset + 500);
        if (batch.length === 0) continue;
        await db.insert(candlesTable)
          .values(batch.map((row) => ({
            ...row,
            timestamp: new Date(row.timestamp),
            updatedAt: new Date(),
          })))
          .onConflictDoUpdate({
            target: [candlesTable.instrumentKey, candlesTable.interval, candlesTable.timestamp],
            set: {
              open: sql`excluded.open`,
              high: sql`excluded.high`,
              low: sql`excluded.low`,
              close: sql`excluded.close`,
              volume: sql`excluded.volume`,
              updatedAt: new Date(),
            },
          });
        upserted += batch.length;
      }
    }
  }
  console.log(JSON.stringify({ instrumentKeys, startDate: START_DATE, endDate, upserted }));
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
