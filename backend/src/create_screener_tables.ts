import { config as dotenvConfig } from "dotenv";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenvConfig({ path: path.resolve(__dirname, "../.env.local"), override: true });
dotenvConfig({ path: path.resolve(__dirname, "../.env") });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "custom_screener" (
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
      "screener_id" integer,
      "symbol" varchar(50) NOT NULL,
      "notes" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "fk_screener_target" FOREIGN KEY ("screener_id") REFERENCES "custom_screener"("id") ON DELETE cascade
    );
  `);
  console.log("Successfully created/verified all screener tables.");
  process.exit(0);
}
run();
