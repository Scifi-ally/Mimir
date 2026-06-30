import { pgTable, varchar, decimal, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const learningMetricsTable = pgTable(
  "learning_metrics",
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    symbol: varchar("symbol", { length: 20 }).notNull(),
    techEdge: decimal("tech_edge", { precision: 5, scale: 2 }),
    regimeAlign: decimal("regime_align", { precision: 5, scale: 2 }),
    regimeLabel: varchar("regime_label", { length: 50 }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => {
    return {
      symbolRegimeIdx: uniqueIndex("symbol_regime_idx").on(table.symbol, table.regimeLabel),
    };
  }
);
