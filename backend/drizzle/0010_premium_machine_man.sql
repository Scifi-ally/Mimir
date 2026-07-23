CREATE TABLE "custom_watchlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_watchlist_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "live_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suggestion_id" uuid,
	"broker_order_id" varchar(64),
	"symbol" varchar(32) NOT NULL,
	"direction" varchar(4) NOT NULL,
	"order_type" varchar(24) NOT NULL,
	"quantity" integer NOT NULL,
	"price" numeric(10, 2),
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"status_message" text,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rejected_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(20) NOT NULL,
	"direction" varchar(5) NOT NULL,
	"setup_type" varchar(30) NOT NULL,
	"rejection_reason" varchar(50) NOT NULL,
	"entry_price" numeric(10, 2) NOT NULL,
	"stop_loss" numeric(10, 2) NOT NULL,
	"target_1" numeric(10, 2) NOT NULL,
	"confidence" integer,
	"market_regime" varchar(30),
	"feature_vector" jsonb,
	"cf_status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"cf_resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "feature_vector" jsonb;--> statement-breakpoint
ALTER TABLE "trading_config" ADD COLUMN "trading_mode" varchar(10) DEFAULT 'PAPER' NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "feature_vector" jsonb;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "setup_type" varchar(30);--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "trade_type" varchar(10);--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "confidence" integer;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "mfe_r" numeric(8, 3);--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "mae_r" numeric(8, 3);--> statement-breakpoint
CREATE INDEX "live_orders_symbol_idx" ON "live_orders" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "live_orders_status_idx" ON "live_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_rejected_candidates_symbol" ON "rejected_candidates" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "idx_rejected_candidates_cf_status" ON "rejected_candidates" USING btree ("cf_status");--> statement-breakpoint
CREATE INDEX "idx_rejected_candidates_created_at" ON "rejected_candidates" USING btree ("created_at");