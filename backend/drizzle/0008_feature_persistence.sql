-- Phase 1.1: persist the full feature vector with each suggestion and copy it
-- into the outcome row at close, so a model can be trained on realized results.
ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "feature_vector" jsonb;
--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN IF NOT EXISTS "feature_vector" jsonb;
--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN IF NOT EXISTS "setup_type" varchar(30);
--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN IF NOT EXISTS "trade_type" varchar(10);
--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN IF NOT EXISTS "confidence" integer;
--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN IF NOT EXISTS "mfe_r" numeric(8, 3);
--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN IF NOT EXISTS "mae_r" numeric(8, 3);
