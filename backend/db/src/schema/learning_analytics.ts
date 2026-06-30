import {
  pgTable,
  uuid,
  varchar,
  decimal,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const learningAnalyticsTable = pgTable("learning_analytics", {
  id: uuid("id").primaryKey().defaultRandom(),
  tag: varchar("tag", { length: 30 }).notNull(), // BEST_SECTOR | BEST_REGIME | OPTIMAL_CONFIDENCE | etc.
  metricName: varchar("metric_name", { length: 50 }).notNull(),
  metricValue: decimal("metric_value", { precision: 10, scale: 2 }).notNull(),
  insights: text("insights"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LearningAnalytic = typeof learningAnalyticsTable.$inferSelect;
export type InsertLearningAnalytic = typeof learningAnalyticsTable.$inferInsert;
