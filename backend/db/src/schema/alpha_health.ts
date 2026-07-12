import { pgTable, timestamp, real, integer, index, serial } from "drizzle-orm/pg-core";

export const alphaScoreIcHistoryTable = pgTable("alpha_score_ic_history", {
  id: serial("id").primaryKey(),
  computedAt: timestamp("computed_at").notNull(),
  icMean: real("ic_mean").notNull(),
  icStd: real("ic_std").notNull(),
  sampleSize: integer("sample_size").notNull(),
}, (t) => ({
  computedAtIdx: index("idx_alpha_score_ic_history_computed_at").on(t.computedAt),
}));
