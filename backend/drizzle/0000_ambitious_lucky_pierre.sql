CREATE TABLE "ai_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suggestion_id" uuid,
	"symbol" varchar(20) NOT NULL,
	"model_name" varchar(50) DEFAULT 'NeoQuasar/Kronos-small' NOT NULL,
	"model_version" varchar(20) DEFAULT '1.0.0' NOT NULL,
	"kronos_score" numeric(5, 2) NOT NULL,
	"chronos_score" numeric(5, 2) NOT NULL,
	"composite_score" numeric(5, 2) NOT NULL,
	"features" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"instrument_key" varchar(100) NOT NULL,
	"interval" varchar(20) NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_screener_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"screener_id" integer NOT NULL,
	"symbol" varchar(50) NOT NULL,
	"timeframe" varchar(10) NOT NULL,
	"condition" text NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "custom_screener" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text DEFAULT 'system' NOT NULL,
	"symbol" varchar(50) NOT NULL,
	"target_type" varchar(50) DEFAULT 'ALL' NOT NULL,
	"output_name" varchar(100),
	"timeframe" varchar(10) NOT NULL,
	"indicator_a" varchar(50),
	"operator" varchar(20),
	"indicator_b" varchar(50),
	"conditions" jsonb,
	"schedule_mode" varchar(30) DEFAULT 'MARKET_OPEN' NOT NULL,
	"schedule_time" varchar(5),
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_screener_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text DEFAULT 'system' NOT NULL,
	"screener_id" integer,
	"symbol" varchar(50) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(20) NOT NULL,
	"name" varchar(100),
	"exchange" varchar(10) DEFAULT 'NSE' NOT NULL,
	"direction" varchar(5) NOT NULL,
	"trade_type" varchar(10) NOT NULL,
	"setup_type" varchar(30) NOT NULL,
	"entry_price" numeric(10, 2) NOT NULL,
	"stop_loss" numeric(10, 2) NOT NULL,
	"target_1" numeric(10, 2) NOT NULL,
	"target_2" numeric(10, 2),
	"risk_reward" numeric(5, 2),
	"quantity" integer NOT NULL,
	"max_risk_inr" numeric(10, 2),
	"stop_distance_pct" numeric(5, 2),
	"market_regime" varchar(20),
	"signal_factors" jsonb,
	"highest_price" numeric(10, 2),
	"lowest_price" numeric(10, 2),
	"atr" numeric(10, 2),
	"reasoning" text,
	"validity_till" varchar(10),
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"outcome_price" numeric(10, 2),
	"pnl_inr" numeric(10, 2),
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "performance_stats" (
	"date" date PRIMARY KEY NOT NULL,
	"total_suggestions" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"expired" integer DEFAULT 0 NOT NULL,
	"win_rate" numeric(5, 2),
	"profit_factor" numeric(5, 2),
	"avg_rr_realized" numeric(5, 2),
	"total_pnl_inr" numeric(12, 2),
	"stats_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "overnight_watchlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"for_date" date NOT NULL,
	"symbol" varchar(20) NOT NULL,
	"name" varchar(100),
	"category" varchar(30) NOT NULL,
	"condition" text,
	"priority" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_metrics" (
	"date" date PRIMARY KEY NOT NULL,
	"nifty_open" numeric(10, 2),
	"nifty_close" numeric(10, 2),
	"nifty_change_pct" numeric(5, 2),
	"india_vix_open" numeric(5, 2),
	"india_vix_close" numeric(5, 2),
	"advance_count" integer,
	"decline_count" integer,
	"regime" varchar(20),
	"strongest_sector" varchar(50),
	"weakest_sector" varchar(50)
);
--> statement-breakpoint
CREATE TABLE "trading_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"trading_capital" numeric(12, 2) DEFAULT '500000' NOT NULL,
	"max_risk_per_trade_pct" numeric(5, 2) DEFAULT '1.0' NOT NULL,
	"max_daily_loss_pct" numeric(5, 2) DEFAULT '3.0' NOT NULL,
	"max_open_positions" integer DEFAULT 5 NOT NULL,
	"max_sector_exposure" integer DEFAULT 2 NOT NULL,
	"min_risk_reward" numeric(5, 2) DEFAULT '1.5' NOT NULL,
	"min_daily_volume" integer DEFAULT 500000 NOT NULL,
	"vix_pause_threshold" numeric(5, 2) DEFAULT '22' NOT NULL,
	"min_suggestion_score" numeric(5, 2) DEFAULT '5.5' NOT NULL,
	"min_mtf_confluence_pct" numeric(5, 2) DEFAULT '45' NOT NULL,
	"min_auto_confidence_pct" numeric(5, 2) DEFAULT '55' NOT NULL,
	"brokerage_per_order_inr" numeric(10, 2) DEFAULT '20' NOT NULL,
	"slippage_bps" numeric(8, 2) DEFAULT '5' NOT NULL,
	"confidence_threshold_by_regime_json" text DEFAULT '{"TRENDING_UP":70,"TRENDING_DOWN":70,"RANGING":74,"VOLATILE":78,"UNKNOWN":72}' NOT NULL,
	"max_same_direction_open_positions" integer DEFAULT 3 NOT NULL,
	"avoid_first_minutes" integer DEFAULT 10 NOT NULL,
	"avoid_midday_start_minute" integer DEFAULT 150 NOT NULL,
	"avoid_midday_end_minute" integer DEFAULT 225 NOT NULL,
	"weekly_loss_limit_pct" numeric(5, 2) DEFAULT '6' NOT NULL,
	"rolling_drawdown_pct" numeric(5, 2) DEFAULT '8' NOT NULL,
	"paper_trading_enabled" boolean DEFAULT true NOT NULL,
	"upstox_api_key" text,
	"upstox_api_secret" text,
	"upstox_redirect_uri" text,
	"upstox_data_api_key" text,
	"upstox_data_api_secret" text,
	"stop_loss_mode" varchar(20) DEFAULT 'FIXED' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstox_token" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"access_token" text NOT NULL,
	"token_type" varchar(30) DEFAULT 'Bearer' NOT NULL,
	"expires_in" integer NOT NULL,
	"obtained_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(50) DEFAULT 'system' NOT NULL,
	"balance" numeric(12, 2) DEFAULT '10000.00' NOT NULL,
	"starting_balance" numeric(12, 2) DEFAULT '10000.00' NOT NULL,
	"allocated_margin" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suggestion_id" uuid,
	"symbol" varchar(20) NOT NULL,
	"direction" varchar(5) NOT NULL,
	"order_type" varchar(20) NOT NULL,
	"quantity" integer NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"status" varchar(20) DEFAULT 'EXECUTED' NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suggestion_id" uuid,
	"symbol" varchar(20) NOT NULL,
	"direction" varchar(5) NOT NULL,
	"quantity" integer NOT NULL,
	"avg_entry_price" numeric(10, 2) NOT NULL,
	"status" varchar(20) DEFAULT 'OPEN' NOT NULL,
	"realized_pnl" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"unrealized_pnl" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"trailing_stop_loss" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "market_regimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"regime" varchar(30) NOT NULL,
	"confidence" numeric(5, 2) NOT NULL,
	"vix" numeric(5, 2),
	"breadth" numeric(5, 2),
	"nifty_trend" varchar(15) NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suggestion_id" uuid,
	"symbol" varchar(20) NOT NULL,
	"direction" varchar(5) NOT NULL,
	"entry_price" numeric(10, 2) NOT NULL,
	"exit_price" numeric(10, 2) NOT NULL,
	"pnl" numeric(10, 2) NOT NULL,
	"duration_minutes" integer,
	"status" varchar(20) NOT NULL,
	"market_regime" varchar(30),
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_analytics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag" varchar(30) NOT NULL,
	"metric_name" varchar(50) NOT NULL,
	"metric_value" numeric(10, 2) NOT NULL,
	"insights" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"regime" varchar(30) NOT NULL,
	"total_stocks" integer NOT NULL,
	"candidates_found" integer NOT NULL,
	"candidates_passed" integer NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "symbol_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(20) NOT NULL,
	"score" integer NOT NULL,
	"for_date" date NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "symbol_scores_symbol_date_unq" UNIQUE("symbol","for_date")
);
--> statement-breakpoint
CREATE TABLE "learning_metrics" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"symbol" varchar(20) NOT NULL,
	"tech_edge" numeric(5, 2),
	"regime_align" numeric(5, 2),
	"regime_label" varchar(50) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_scores" ADD CONSTRAINT "ai_scores_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_screener_matches" ADD CONSTRAINT "custom_screener_matches_screener_id_custom_screener_id_fk" FOREIGN KEY ("screener_id") REFERENCES "public"."custom_screener"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_screener_targets" ADD CONSTRAINT "custom_screener_targets_screener_id_custom_screener_id_fk" FOREIGN KEY ("screener_id") REFERENCES "public"."custom_screener"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD CONSTRAINT "signal_outcomes_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_candle_idx" ON "candles" USING btree ("instrument_key","interval","timestamp");--> statement-breakpoint
CREATE INDEX "suggestions_status_idx" ON "suggestions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "suggestions_generated_at_idx" ON "suggestions" USING btree ("generated_at");--> statement-breakpoint
CREATE INDEX "suggestions_symbol_generated_idx" ON "suggestions" USING btree ("symbol","generated_at");--> statement-breakpoint
CREATE INDEX "watchlist_symbol_date_idx" ON "overnight_watchlist" USING btree ("symbol","for_date");--> statement-breakpoint
CREATE INDEX "watchlist_date_priority_idx" ON "overnight_watchlist" USING btree ("for_date","priority");--> statement-breakpoint
CREATE INDEX "paper_accounts_user_id_idx" ON "paper_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "paper_orders_symbol_idx" ON "paper_orders" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "paper_orders_suggestion_idx" ON "paper_orders" USING btree ("suggestion_id");--> statement-breakpoint
CREATE INDEX "paper_positions_status_idx" ON "paper_positions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "paper_positions_suggestion_idx" ON "paper_positions" USING btree ("suggestion_id");--> statement-breakpoint
CREATE INDEX "market_regimes_detected_at_idx" ON "market_regimes" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "signal_outcomes_suggestion_idx" ON "signal_outcomes" USING btree ("suggestion_id");--> statement-breakpoint
CREATE INDEX "signal_outcomes_symbol_idx" ON "signal_outcomes" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "signal_outcomes_closed_at_idx" ON "signal_outcomes" USING btree ("closed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "symbol_regime_idx" ON "learning_metrics" USING btree ("symbol","regime_label");