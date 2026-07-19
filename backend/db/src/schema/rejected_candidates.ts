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

/**
 * Every scored candidate that did NOT become a suggestion, with the features
 * it was scored on and the planned levels it would have traded. The outcome
 * checker later resolves what WOULD have happened (counterfactual label), so
 * ranker training sees the full candidate distribution instead of only the
 * survivorship-filtered winners — the negatives the model most needs.
 */
export const rejectedCandidatesTable = pgTable("rejected_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  direction: varchar("direction", { length: 5 }).notNull(),
  setupType: varchar("setup_type", { length: 30 }).notNull(),
  rejectionReason: varchar("rejection_reason", { length: 50 }).notNull(),
  entryPrice: decimal("entry_price", { precision: 10, scale: 2 }).notNull(),
  stopLoss: decimal("stop_loss", { precision: 10, scale: 2 }).notNull(),
  target1: decimal("target_1", { precision: 10, scale: 2 }).notNull(),
  confidence: integer("confidence"),
  marketRegime: varchar("market_regime", { length: 30 }),
  featureVector: jsonb("feature_vector"),
  // Counterfactual resolution — filled by the outcome poller.
  // PENDING → WOULD_HAVE_WON | WOULD_HAVE_LOST | NEVER_TRIGGERED
  cfStatus: varchar("cf_status", { length: 20 }).notNull().default("PENDING"),
  cfResolvedAt: timestamp("cf_resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  symbolIdx: index("idx_rejected_candidates_symbol").on(t.symbol),
  cfStatusIdx: index("idx_rejected_candidates_cf_status").on(t.cfStatus),
  createdAtIdx: index("idx_rejected_candidates_created_at").on(t.createdAt),
}));

export type RejectedCandidate = typeof rejectedCandidatesTable.$inferSelect;
export type InsertRejectedCandidate = typeof rejectedCandidatesTable.$inferInsert;
