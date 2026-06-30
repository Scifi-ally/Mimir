import {
  pgTable,
  varchar,
  timestamp,
  doublePrecision,
  bigint,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Candles Table
 * Stores historical candlestick data (e.g. 1m, 5m, 15m, 1h, 1d) fetched from Upstox.
 * This acts as a persistent cache. On restart, the in-memory tick and candle buffers 
 * are empty, but the system dynamically loads the last 10 days of historical 1-minute 
 * candles from the Upstox API on-demand for any active candidate. Therefore, there is 
 * no risk of permanent data loss or disrupted monitoring on restarts.
 */
export const candlesTable = pgTable("candles", {
  instrumentKey: varchar("instrument_key", { length: 100 }).notNull(),
  interval: varchar("interval", { length: 20 }).notNull(), // '60minute', '240minute', 'day', 'week'
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  open: doublePrecision("open").notNull(),
  high: doublePrecision("high").notNull(),
  low: doublePrecision("low").notNull(),
  close: doublePrecision("close").notNull(),
  volume: bigint("volume", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueCandleIdx: uniqueIndex("unique_candle_idx").on(
    table.instrumentKey,
    table.interval,
    table.timestamp
  ),
}));

export type CandleRow = typeof candlesTable.$inferSelect;
export type InsertCandleRow = typeof candlesTable.$inferInsert;
