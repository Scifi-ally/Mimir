import { pgTable, date, decimal, integer, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const marketMetricsTable = pgTable("market_metrics", {
  date: date("date").primaryKey(),
  niftyOpen: decimal("nifty_open", { precision: 10, scale: 2 }),
  niftyClose: decimal("nifty_close", { precision: 10, scale: 2 }),
  niftyChangePct: decimal("nifty_change_pct", { precision: 5, scale: 2 }),
  indiaVixOpen: decimal("india_vix_open", { precision: 5, scale: 2 }),
  indiaVixClose: decimal("india_vix_close", { precision: 5, scale: 2 }),
  advanceCount: integer("advance_count"),
  declineCount: integer("decline_count"),
  regime: varchar("regime", { length: 20 }),
  strongestSector: varchar("strongest_sector", { length: 50 }),
  weakestSector: varchar("weakest_sector", { length: 50 }),
});

export const insertMarketMetricsSchema =
  createInsertSchema(marketMetricsTable);
export type InsertMarketMetrics = z.infer<typeof insertMarketMetricsSchema>;
export type MarketMetrics = typeof marketMetricsTable.$inferSelect;
