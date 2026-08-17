import {
  date,
  jsonb,
  real,
  text,
  timestamp,
  uuid,
  varchar,
  integer,
  uniqueIndex,
  pgTable,
} from "drizzle-orm/pg-core";

export const scrapeverseFiiDiiFlowsTable = pgTable("scrapeverse_fii_dii_flows", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: varchar("source", { length: 80 }).notNull(),
  sourceUrl: text("source_url").notNull(),
  dataAsOf: date("data_as_of").notNull(),
  category: varchar("category", { length: 20 }).notNull(),
  segment: varchar("segment", { length: 30 }).notNull(),
  grossPurchaseCrore: real("gross_purchase_crore").notNull(),
  grossSalesCrore: real("gross_sales_crore").notNull(),
  netCrore: real("net_crore").notNull(),
  scrapedAt: timestamp("scraped_at", { withTimezone: true }).notNull(),
  collectorId: varchar("collector_id", { length: 100 }).notNull(),
  collectionId: varchar("collection_id", { length: 120 }).notNull(),
  rawRecordHash: varchar("raw_record_hash", { length: 64 }).notNull(),
  validationStatus: varchar("validation_status", { length: 20 }).notNull(),
  rawPayload: jsonb("raw_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  flowIdentity: uniqueIndex("scrapeverse_fii_dii_flow_identity").on(
    table.source,
    table.dataAsOf,
    table.category,
    table.segment,
  ),
}));

export const scrapeverseCollectorRunsTable = pgTable("scrapeverse_collector_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  collectorId: varchar("collector_id", { length: 100 }).notNull(),
  collectionId: varchar("collection_id", { length: 120 }),
  sourceUrl: text("source_url").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  status: varchar("status", { length: 30 }).notNull(),
  rowsReceived: integer("rows_received").notNull().default(0),
  rowsValid: integer("rows_valid").notNull().default(0),
  completenessRate: real("completeness_rate").notNull().default(0),
  lastError: text("last_error"),
  selfHealEventId: varchar("self_heal_event_id", { length: 120 }),
  rawResponse: jsonb("raw_response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  collectionIdentity: uniqueIndex("scrapeverse_collector_runs_collection_id").on(table.collectionId),
}));
