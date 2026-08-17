CREATE TABLE "scrapeverse_collector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collector_id" varchar(100) NOT NULL,
	"collection_id" varchar(120),
	"source_url" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" varchar(30) NOT NULL,
	"rows_received" integer DEFAULT 0 NOT NULL,
	"rows_valid" integer DEFAULT 0 NOT NULL,
	"completeness_rate" real DEFAULT 0 NOT NULL,
	"last_error" text,
	"self_heal_event_id" varchar(120),
	"raw_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scrapeverse_fii_dii_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" varchar(80) NOT NULL,
	"source_url" text NOT NULL,
	"data_as_of" date NOT NULL,
	"category" varchar(20) NOT NULL,
	"segment" varchar(30) NOT NULL,
	"gross_purchase_crore" real NOT NULL,
	"gross_sales_crore" real NOT NULL,
	"net_crore" real NOT NULL,
	"scraped_at" timestamp with time zone NOT NULL,
	"collector_id" varchar(100) NOT NULL,
	"collection_id" varchar(120) NOT NULL,
	"raw_record_hash" varchar(64) NOT NULL,
	"validation_status" varchar(20) NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fundamental_snapshots" ALTER COLUMN "filed_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fundamental_snapshots" ALTER COLUMN "fetched_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fundamental_snapshots" ALTER COLUMN "fetched_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "learning_metrics" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_metrics" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "decision_trace" jsonb;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "outcome_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rejected_candidates" ADD COLUMN "decision_trace" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "scrapeverse_collector_runs_collection_id" ON "scrapeverse_collector_runs" USING btree ("collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scrapeverse_fii_dii_flow_identity" ON "scrapeverse_fii_dii_flows" USING btree ("source","data_as_of","category","segment");