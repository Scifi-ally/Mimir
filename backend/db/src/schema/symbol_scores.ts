import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  date,
  unique,
} from "drizzle-orm/pg-core";

export const symbolScoresTable = pgTable("symbol_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  score: integer("score").notNull(),
  forDate: date("for_date").notNull(),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  symbolDateUnq: unique("symbol_scores_symbol_date_unq").on(t.symbol, t.forDate)
}));

export type SymbolScore = typeof symbolScoresTable.$inferSelect;
export type InsertSymbolScore = typeof symbolScoresTable.$inferInsert;
