ALTER TABLE "suggestions" ADD COLUMN "expected_hold_minutes" integer;
--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "suggestions_active_expiry_idx" ON "suggestions" USING btree ("status", "expires_at");
