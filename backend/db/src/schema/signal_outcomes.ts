import {
  pgTable,
  uuid,
  varchar,
  decimal,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { suggestionsTable } from "./suggestions";

export const signalOutcomesTable = pgTable("signal_outcomes", {
  id: uuid("id").primaryKey().defaultRandom(),
  suggestionId: uuid("suggestion_id").references(() => suggestionsTable.id, { onDelete: "cascade" }),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  direction: varchar("direction", { length: 5 }).notNull(), // BUY | SELL
  entryPrice: decimal("entry_price", { precision: 10, scale: 2 }).notNull(),
  exitPrice: decimal("exit_price", { precision: 10, scale: 2 }).notNull(),
  pnl: decimal("pnl", { precision: 10, scale: 2 }).notNull(),
  durationMinutes: integer("duration_minutes"),
  status: varchar("status", { length: 20 }).notNull(), // TARGET_1_HIT, STOP_HIT, etc.
  marketRegime: varchar("market_regime", { length: 30 }),
  // Training labels/features: the feature vector captured at signal time, plus
  // setup/trade context and realized excursions in R-multiples. Populated by the
  // learning pipeline when a suggestion closes.
  featureVector: jsonb("feature_vector"),
  setupType: varchar("setup_type", { length: 30 }),
  tradeType: varchar("trade_type", { length: 10 }),
  confidence: integer("confidence"),
  mfeR: decimal("mfe_r", { precision: 8, scale: 3 }),
  maeR: decimal("mae_r", { precision: 8, scale: 3 }),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  suggestionIdx: index("signal_outcomes_suggestion_idx").on(table.suggestionId),
  symbolIdx: index("signal_outcomes_symbol_idx").on(table.symbol),
  closedAtIdx: index("signal_outcomes_closed_at_idx").on(table.closedAt),
}));

export type SignalOutcome = typeof signalOutcomesTable.$inferSelect;
export type InsertSignalOutcome = typeof signalOutcomesTable.$inferInsert;
