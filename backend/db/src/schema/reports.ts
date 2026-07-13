import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const dailyReportsTable = pgTable("daily_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  date: varchar("date", { length: 10 }).notNull().unique(),
  summary: varchar("summary", { length: 255 }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDailyReportSchema = createInsertSchema(dailyReportsTable);
export const selectDailyReportSchema = createSelectSchema(dailyReportsTable);
export type DailyReport = typeof dailyReportsTable.$inferSelect;
