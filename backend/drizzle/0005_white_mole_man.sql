CREATE TABLE "alpha_score_ic_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"computed_at" timestamp NOT NULL,
	"ic_mean" real NOT NULL,
	"ic_std" real NOT NULL,
	"sample_size" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fundamental_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" varchar(50) NOT NULL,
	"field_name" varchar(100) NOT NULL,
	"value" real,
	"text_value" text,
	"filed_date" timestamp NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" varchar(10) NOT NULL,
	"summary" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_reports_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "institutional_flows" (
	"date" date PRIMARY KEY NOT NULL,
	"fii_net" real NOT NULL,
	"dii_net" real NOT NULL,
	"fii_index_futures_net" real NOT NULL,
	"fii_stock_futures_net" real NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_accounts" ALTER COLUMN "balance" SET DEFAULT '500000.00';--> statement-breakpoint
ALTER TABLE "paper_accounts" ALTER COLUMN "starting_balance" SET DEFAULT '500000.00';--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "confidence" integer;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "ai_score" integer;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "pattern_score" integer;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "chronos_score" integer;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "technical_score" integer;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "sentiment_score" integer;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "ranking_mode" varchar(20);--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "expected_hold_minutes" integer;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "stop_loss_mode" varchar(20);--> statement-breakpoint
ALTER TABLE "trading_config" ADD COLUMN "max_deployed_capital_pct" numeric(5, 2) DEFAULT '90';--> statement-breakpoint
ALTER TABLE "trading_config" ADD COLUMN "discord_webhook_url" text;--> statement-breakpoint
ALTER TABLE "trading_config" ADD COLUMN "telegram_bot_token" text;--> statement-breakpoint
ALTER TABLE "trading_config" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD COLUMN "context_data" jsonb;--> statement-breakpoint
CREATE INDEX "idx_alpha_score_ic_history_computed_at" ON "alpha_score_ic_history" USING btree ("computed_at");--> statement-breakpoint
CREATE INDEX "idx_fundamental_snapshots_symbol" ON "fundamental_snapshots" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "idx_fundamental_snapshots_field" ON "fundamental_snapshots" USING btree ("field_name");--> statement-breakpoint
CREATE INDEX "idx_fundamental_snapshots_filed_date" ON "fundamental_snapshots" USING btree ("filed_date");--> statement-breakpoint
CREATE INDEX "idx_institutional_flows_date" ON "institutional_flows" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_ai_scores_symbol" ON "ai_scores" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "idx_ai_scores_suggestion_id" ON "ai_scores" USING btree ("suggestion_id");--> statement-breakpoint
CREATE INDEX "idx_ai_scores_created_at" ON "ai_scores" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "paper_positions_symbol_idx" ON "paper_positions" USING btree ("symbol");