import {
  pgTable,
  uuid,
  varchar,
  integer,
  decimal,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Live Orders — audit trail of every real order sent to the broker.
 * One row per order attempt; broker_order_id links to Upstox for reconciliation.
 */
export const liveOrdersTable = pgTable(
  "live_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    suggestionId: uuid("suggestion_id"),
    brokerOrderId: varchar("broker_order_id", { length: 64 }),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    direction: varchar("direction", { length: 4 }).notNull(), // BUY | SELL
    orderType: varchar("order_type", { length: 24 }).notNull(), // ENTRY | TARGET_EXIT | STOP_EXIT | MANUAL_EXIT
    quantity: integer("quantity").notNull(),
    price: decimal("price", { precision: 10, scale: 2 }),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"), // PENDING | PLACED | REJECTED | FAILED | CANCELLED
    statusMessage: text("status_message"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    symbolIdx: index("live_orders_symbol_idx").on(table.symbol),
    statusIdx: index("live_orders_status_idx").on(table.status),
  }),
);

export type LiveOrderRow = typeof liveOrdersTable.$inferSelect;
export type InsertLiveOrderRow = typeof liveOrdersTable.$inferInsert;
