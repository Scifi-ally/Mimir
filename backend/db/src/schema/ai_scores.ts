import {
  pgTable,
  uuid,
  varchar,
  decimal,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { suggestionsTable } from "./suggestions";

export const aiScoresTable = pgTable("ai_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  suggestionId: uuid("suggestion_id").references(() => suggestionsTable.id, { onDelete: "cascade" }),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  modelName: varchar("model_name", { length: 50 }).notNull().default("NeoQuasar/Kronos-small"),
  modelVersion: varchar("model_version", { length: 20 }).notNull().default("1.0.0"),
  kronosScore: decimal("kronos_score", { precision: 5, scale: 2 }).notNull(),
  chronosScore: decimal("chronos_score", { precision: 5, scale: 2 }).notNull(),
  compositeScore: decimal("composite_score", { precision: 5, scale: 2 }).notNull(),
  features: jsonb("features").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  symbolIdx: index("idx_ai_scores_symbol").on(t.symbol),
  suggestionIdIdx: index("idx_ai_scores_suggestion_id").on(t.suggestionId),
  createdAtIdx: index("idx_ai_scores_created_at").on(t.createdAt),
}));

export type AiScore = typeof aiScoresTable.$inferSelect;
export type InsertAiScore = typeof aiScoresTable.$inferInsert;
