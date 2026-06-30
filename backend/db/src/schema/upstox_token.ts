import { integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const upstoxTokenTable = pgTable("upstox_token", {
  id: integer("id").primaryKey().default(1),
  accessToken: text("access_token").notNull(),
  tokenType: varchar("token_type", { length: 30 }).notNull().default("Bearer"),
  expiresIn: integer("expires_in").notNull(),
  obtainedAt: timestamp("obtained_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UpstoxTokenRow = typeof upstoxTokenTable.$inferSelect;
