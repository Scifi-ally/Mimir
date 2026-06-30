import {
  pgTable,
  date,
  integer,
  decimal,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const performanceStatsTable = pgTable("performance_stats", {
  date: date("date").primaryKey(),
  totalSuggestions: integer("total_suggestions").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  expired: integer("expired").notNull().default(0),
  winRate: decimal("win_rate", { precision: 5, scale: 2 }),
  profitFactor: decimal("profit_factor", { precision: 5, scale: 2 }),
  avgRrRealized: decimal("avg_rr_realized", { precision: 5, scale: 2 }),
  totalPnlInr: decimal("total_pnl_inr", { precision: 12, scale: 2 }),
  statsJson: jsonb("stats_json"),
});

export const insertPerformanceStatsSchema = createInsertSchema(
  performanceStatsTable
);
export type InsertPerformanceStats = z.infer<
  typeof insertPerformanceStatsSchema
>;
export type PerformanceStats = typeof performanceStatsTable.$inferSelect;
