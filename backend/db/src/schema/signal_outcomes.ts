import {
  pgTable,
  uuid,
  varchar,
  decimal,
  integer,
  timestamp,
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
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  suggestionIdx: index("signal_outcomes_suggestion_idx").on(table.suggestionId),
  symbolIdx: index("signal_outcomes_symbol_idx").on(table.symbol),
  closedAtIdx: index("signal_outcomes_closed_at_idx").on(table.closedAt),
}));

export type SignalOutcome = typeof signalOutcomesTable.$inferSelect;
export type InsertSignalOutcome = typeof signalOutcomesTable.$inferInsert;
