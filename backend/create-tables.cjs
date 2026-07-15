const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: false });
require('dotenv').config({ path: '.env.local' });
require('dotenv').config({ path: '.env', override: false });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:change_me@127.0.0.1:5433/upstox_bot'
});

async function run() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "custom_screener" (
        "id" serial PRIMARY KEY NOT NULL,
        "user_id" text DEFAULT 'system' NOT NULL,
        "symbol" varchar(50) NOT NULL,
        "timeframe" varchar(10) NOT NULL,
        "indicator_a" varchar(50) NOT NULL,
        "operator" varchar(20) NOT NULL,
        "indicator_b" varchar(50) NOT NULL,
        "schedule_mode" varchar(30) DEFAULT 'MARKET_OPEN' NOT NULL,
        "schedule_time" varchar(5),
        "status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
        "last_triggered_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "custom_screener_matches" (
        "id" serial PRIMARY KEY NOT NULL,
        "screener_id" integer NOT NULL,
        "symbol" varchar(50) NOT NULL,
        "timeframe" varchar(10) NOT NULL,
        "condition" text NOT NULL,
        "matched_at" timestamp with time zone DEFAULT now() NOT NULL,
        "acknowledged" boolean DEFAULT false,
        CONSTRAINT "fk_screener" FOREIGN KEY ("screener_id") REFERENCES "custom_screener"("id") ON DELETE cascade
      );

      CREATE TABLE IF NOT EXISTS "custom_screener_targets" (
        "id" serial PRIMARY KEY NOT NULL,
        "user_id" text DEFAULT 'system' NOT NULL,
        "symbol" varchar(50) NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "learning_metrics" (
        "id" varchar(255) PRIMARY KEY NOT NULL,
        "symbol" varchar(20) NOT NULL,
        "tech_edge" numeric(5, 2),
        "regime_align" numeric(5, 2),
        "regime_label" varchar(50) NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "symbol_regime_idx" ON "learning_metrics" ("symbol", "regime_label");
    `);
    console.log("Tables created successfully");
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
