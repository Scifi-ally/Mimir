import { pgTable, date, real, index } from "drizzle-orm/pg-core";

export const institutionalFlowsTable = pgTable("institutional_flows", {
  date: date("date").primaryKey(), // YYYY-MM-DD
  fiiNet: real("fii_net").notNull(),
  diiNet: real("dii_net").notNull(),
  fiiIndexFuturesNet: real("fii_index_futures_net").notNull(),
  fiiStockFuturesNet: real("fii_stock_futures_net").notNull(),
}, (t) => ({
  dateIdx: index("idx_institutional_flows_date").on(t.date),
}));
