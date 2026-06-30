import {
  pgTable,
  uuid,
  varchar,
  decimal,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

import { suggestionsTable } from "./suggestions";

/**
 * Paper Trading Accounts Table
 * Tracks the overall paper balance, used margin, and starting equity.
 */
export const paperAccountsTable = pgTable("paper_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: varchar("user_id", { length: 50 }).notNull().default("system"),
  balance: decimal("balance", { precision: 12, scale: 2 }).notNull().default("10000.00"),
  startingBalance: decimal("starting_balance", { precision: 12, scale: 2 }).notNull().default("10000.00"),
  allocatedMargin: decimal("allocated_margin", { precision: 12, scale: 2 }).notNull().default("0.00"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index("paper_accounts_user_id_idx").on(table.userId),
}));

/**
 * Paper Orders Table
 * Immutable ledger of all virtual order executions.
 */
export const paperOrdersTable = pgTable("paper_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  suggestionId: uuid("suggestion_id").references(() => suggestionsTable.id, { onDelete: "cascade" }),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  direction: varchar("direction", { length: 5 }).notNull(), // BUY | SELL
  orderType: varchar("order_type", { length: 20 }).notNull(), // ENTRY | TARGET_EXIT | STOP_EXIT
  quantity: integer("quantity").notNull(),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("EXECUTED"),
  executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  symbolIdx: index("paper_orders_symbol_idx").on(table.symbol),
  suggestionIdx: index("paper_orders_suggestion_idx").on(table.suggestionId),
}));

/**
 * Paper Positions Table
 * Tracks the live open positions taken by the paper trading engine.
 */
export const paperPositionsTable = pgTable("paper_positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  suggestionId: uuid("suggestion_id").references(() => suggestionsTable.id, { onDelete: "cascade" }),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  direction: varchar("direction", { length: 5 }).notNull(), // BUY | SELL
  quantity: integer("quantity").notNull(),
  avgEntryPrice: decimal("avg_entry_price", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("OPEN"), // OPEN | CLOSED
  realizedPnl: decimal("realized_pnl", { precision: 10, scale: 2 }).notNull().default("0.00"),
  unrealizedPnl: decimal("unrealized_pnl", { precision: 10, scale: 2 }).notNull().default("0.00"),
  trailingStopLoss: decimal("trailing_stop_loss", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (table) => ({
  statusIdx: index("paper_positions_status_idx").on(table.status),
  suggestionIdx: index("paper_positions_suggestion_idx").on(table.suggestionId),
}));

export const insertPaperAccountSchema = createInsertSchema(paperAccountsTable);
export const selectPaperAccountSchema = createSelectSchema(paperAccountsTable);
export type PaperAccount = typeof paperAccountsTable.$inferSelect;

export const insertPaperOrderSchema = createInsertSchema(paperOrdersTable);
export const selectPaperOrderSchema = createSelectSchema(paperOrdersTable);
export type PaperOrder = typeof paperOrdersTable.$inferSelect;

export const insertPaperPositionSchema = createInsertSchema(paperPositionsTable);
export const selectPaperPositionSchema = createSelectSchema(paperPositionsTable);
export type PaperPosition = typeof paperPositionsTable.$inferSelect;
