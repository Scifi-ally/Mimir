import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

export const scanHistoryTable = pgTable("scan_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  regime: varchar("regime", { length: 30 }).notNull(),
  totalStocks: integer("total_stocks").notNull(),
  candidatesFound: integer("candidates_found").notNull(),
  candidatesPassed: integer("candidates_passed").notNull(),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ScanHistoryRecord = typeof scanHistoryTable.$inferSelect;
export type InsertScanHistory = typeof scanHistoryTable.$inferInsert;
