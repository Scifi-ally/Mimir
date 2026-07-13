ALTER TABLE "custom_screener_runs" ADD COLUMN "config_hash" text;--> statement-breakpoint
ALTER TABLE "custom_screener_runs" ADD COLUMN "universe_scanned" integer;--> statement-breakpoint
ALTER TABLE "custom_screener_runs" ADD COLUMN "generated_candidates" integer;--> statement-breakpoint
ALTER TABLE "custom_screener_runs" ADD COLUMN "metadata" jsonb;