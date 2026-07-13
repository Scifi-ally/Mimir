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
CREATE INDEX "idx_fundamental_snapshots_symbol" ON "fundamental_snapshots" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "idx_fundamental_snapshots_field" ON "fundamental_snapshots" USING btree ("field_name");--> statement-breakpoint
CREATE INDEX "idx_fundamental_snapshots_filed_date" ON "fundamental_snapshots" USING btree ("filed_date");

--> statement-breakpoint
ALTER TABLE "paper_accounts" ALTER COLUMN "balance" SET DEFAULT '500000.00';--> statement-breakpoint
ALTER TABLE "paper_accounts" ALTER COLUMN "starting_balance" SET DEFAULT '500000.00';