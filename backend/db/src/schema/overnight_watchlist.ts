import {
  pgTable,
  uuid,
  date,
  varchar,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Overnight Watchlist Table
 * Stores stocks qualified by the overnight scanning pipelines for the next trading day.
 * Re-loaded automatically upon process restarts to restore the day's active symbol set.
 */
export const overnightWatchlistTable = pgTable("overnight_watchlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  forDate: date("for_date").notNull(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  name: varchar("name", { length: 100 }),
  category: varchar("category", { length: 30 }).notNull(), // MOMENTUM | BREAKOUT_WATCH | GAP_CANDIDATE | INTRADAY_BUY | INTRADAY_SELL | AVOID
  // Which pipeline wrote this row. Four scanners share this table
  // (overnight, post-market, gap, intraday) and each used to delete every row
  // for the date before inserting its own, so running the post-market scanner
  // manually after the off-hours scan replaced the richer off-hours output with
  // a weaker set derived from a different scoring model. Scoping deletes to a
  // source makes that impossible.
  source: varchar("source", { length: 30 }).notNull().default("OFFHOURS_SCAN"),
  condition: text("condition"),
  priority: integer("priority"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  symbolDateIdx: index("watchlist_symbol_date_idx").on(table.symbol, table.forDate),
  datePriorityIdx: index("watchlist_date_priority_idx").on(table.forDate, table.priority),
}));

export const insertOvernightWatchlistSchema = createInsertSchema(
  overnightWatchlistTable
).omit({ id: true, createdAt: true });
export type InsertOvernightWatchlist = z.infer<
  typeof insertOvernightWatchlistSchema
>;
export type OvernightWatchlist = typeof overnightWatchlistTable.$inferSelect;
