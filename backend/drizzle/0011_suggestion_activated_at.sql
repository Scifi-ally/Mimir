-- Fill moment for PENDING->ACTIVE promotions. Outcome evaluation windows start
-- here (falling back to generated_at) so pre-fill price action can never decide
-- a STOP_HIT/TARGET outcome, and the floor survives restarts.
ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;
