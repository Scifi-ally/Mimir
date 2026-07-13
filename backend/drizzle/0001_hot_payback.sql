CREATE TABLE "custom_screener_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"trading_session_date" varchar(10) NOT NULL,
	"status" varchar(20) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"trigger_type" varchar(20) NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "active_scan_idx" ON "custom_screener_runs" USING btree ("trading_session_date") WHERE is_active = true;