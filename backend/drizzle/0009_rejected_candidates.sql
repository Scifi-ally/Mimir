-- Counterfactual capture: every scored candidate that was rejected by a risk
-- gate, with its feature vector and planned levels, so the outcome poller can
-- resolve what WOULD have happened and ranker training sees true negatives.
CREATE TABLE IF NOT EXISTS "rejected_candidates" (
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
CREATE INDEX IF NOT EXISTS "idx_rejected_candidates_symbol" ON "rejected_candidates" ("symbol");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_rejected_candidates_cf_status" ON "rejected_candidates" ("cf_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_rejected_candidates_created_at" ON "rejected_candidates" ("created_at");
