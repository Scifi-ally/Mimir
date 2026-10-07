import { sql } from "drizzle-orm";
import { db } from "../../db/src";
import { NSE_UNIVERSE } from "./stock_scanner";
import type { OHLCV } from "./types";

/** Read the entire observed peer population, including names with no setup.
 * A failed read leaves the benchmark unknown; callers must not impute neutral. */
export async function loadSectorHistories(): Promise<{ histories: Map<string, OHLCV[]>; sectors: Map<string, string> }> {
  const result = await db.execute(sql`
    SELECT instrument_key, timestamp, open, high, low, close, volume FROM (
      SELECT instrument_key, timestamp, open, high, low, close, volume,
        row_number() OVER (PARTITION BY instrument_key ORDER BY timestamp DESC) AS recency
      FROM candles WHERE interval = 'day'
    ) recent WHERE recency <= 100 ORDER BY timestamp
  `);
  const meta = new Map(NSE_UNIVERSE.map(s => [s.key, s]));
  const histories = new Map<string, OHLCV[]>(), sectors = new Map<string, string>();
  for (const row of result.rows) {
    const stock = meta.get(String(row.instrument_key));
    if (!stock) continue;
    const candles = histories.get(stock.symbol) ?? [];
    candles.push({ timestamp: new Date(String(row.timestamp)).toISOString(),
      open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume) });
    histories.set(stock.symbol, candles); sectors.set(stock.symbol, stock.sector);
  }
  return { histories, sectors };
}
