import { pgTable, serial, integer, text, timestamp, varchar, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const customScreenerTable = pgTable("custom_screener", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default("system"),
  symbol: varchar("symbol", { length: 50 }).notNull(), // Legacy: 'ALL' or symbol
  targetType: varchar("target_type", { length: 50 }).notNull().default("ALL"), // 'ALL', 'WATCHLIST_1', etc
  outputName: varchar("output_name", { length: 100 }), // Name of the resulting watchlist
  timeframe: varchar("timeframe", { length: 10 }).notNull(), // '1m', '5m', '15m', '1h', '1d'
  indicatorA: varchar("indicator_a", { length: 50 }), // Legacy
  operator: varchar("operator", { length: 20 }), // Legacy
  indicatorB: varchar("indicator_b", { length: 50 }), // Legacy
  conditions: jsonb("conditions"), // New nested JSON rules
  scheduleMode: varchar("schedule_mode", { length: 30 }).notNull().default("MARKET_OPEN"),
  scheduleTime: varchar("schedule_time", { length: 5 }),
  status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
  lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customScreenerMatchesTable = pgTable("custom_screener_matches", {
  id: serial("id").primaryKey(),
  screenerId: integer("screener_id").notNull().references(() => customScreenerTable.id, { onDelete: "cascade" }),
  symbol: varchar("symbol", { length: 50 }).notNull(),
  timeframe: varchar("timeframe", { length: 10 }).notNull(),
  condition: text("condition").notNull(),
  matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
  acknowledged: boolean("acknowledged").default(false),
});

export const customScreenerTargetsTable = pgTable("custom_screener_targets", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default("system"),
  screenerId: integer("screener_id").references(() => customScreenerTable.id, { onDelete: "cascade" }),
  symbol: varchar("symbol", { length: 50 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customScreenerRunsTable = pgTable("custom_screener_runs", {
  id: serial("id").primaryKey(),
  tradingSessionDate: varchar("trading_session_date", { length: 10 }).notNull(), // e.g., '2026-07-11'
  status: varchar("status", { length: 20 }).notNull(), // 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  triggerType: varchar("trigger_type", { length: 20 }).notNull(), // 'AUTOMATIC', 'MANUAL'
  isActive: boolean("is_active").notNull().default(false), // Only one active run per trading session
  configHash: text("config_hash"),
  universeScanned: integer("universe_scanned"),
  generatedCandidates: integer("generated_candidates"),
  metadata: jsonb("metadata"),
}, (table) => {
  return {
    activeScanIdx: uniqueIndex("active_scan_idx")
      .on(table.tradingSessionDate)
      .where(sql`is_active = true`), // Only one active scan per session date allowed
  };
});
