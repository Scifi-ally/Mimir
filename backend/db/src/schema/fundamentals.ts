import { pgTable, text, timestamp, varchar, real, index, serial } from "drizzle-orm/pg-core";

export const fundamentalSnapshotsTable = pgTable("fundamental_snapshots", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 50 }).notNull(),
  fieldName: varchar("field_name", { length: 100 }).notNull(),
  value: real("value"),
  textValue: text("text_value"),
  filedDate: timestamp("filed_date").notNull(),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
}, (t) => ({
  symbolIdx: index("idx_fundamental_snapshots_symbol").on(t.symbol),
  fieldIdx: index("idx_fundamental_snapshots_field").on(t.fieldName),
  filedDateIdx: index("idx_fundamental_snapshots_filed_date").on(t.filedDate),
}));
