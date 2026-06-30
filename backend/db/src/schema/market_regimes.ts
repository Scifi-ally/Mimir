import {
  pgTable,
  uuid,
  varchar,
  decimal,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const marketRegimesTable = pgTable("market_regimes", {
  id: uuid("id").primaryKey().defaultRandom(),
  regime: varchar("regime", { length: 30 }).notNull(),
  confidence: decimal("confidence", { precision: 5, scale: 2 }).notNull(),
  vix: decimal("vix", { precision: 5, scale: 2 }),
  breadth: decimal("breadth", { precision: 5, scale: 2 }), // Sector or overall advance/decline
  niftyTrend: varchar("nifty_trend", { length: 15 }).notNull(), // UP | DOWN | SIDEWAYS
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  detectedAtIdx: index("market_regimes_detected_at_idx").on(table.detectedAt),
}));

export type MarketRegimeRecord = typeof marketRegimesTable.$inferSelect;
export type InsertMarketRegime = typeof marketRegimesTable.$inferInsert;
