import {
  pgTable,
  uuid,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Custom Watchlist Table
 * Stores manually added stocks that are monitored continuously alongside screener outputs.
 */
export const customWatchlistTable = pgTable("custom_watchlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: varchar("symbol", { length: 20 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCustomWatchlistSchema = createInsertSchema(
  customWatchlistTable
).omit({ id: true, createdAt: true });

export type InsertCustomWatchlist = z.infer<typeof insertCustomWatchlistSchema>;
export type CustomWatchlist = typeof customWatchlistTable.$inferSelect;
