import "../load-env.cjs";
import { config as dotenvConfig } from "dotenv";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, "..");
dotenvConfig({ path: resolve(backendRoot, ".env.local"), override: true });
dotenvConfig({ path: resolve(backendRoot, ".env") });

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be configured");

const journal = JSON.parse(readFileSync(resolve(backendRoot, "drizzle/meta/_journal.json"), "utf8"));
const migrationsDir = resolve(backendRoot, "drizzle");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

const migrationSql = readFileSync(resolve(migrationsDir, "0012_chubby_doctor_faustus.sql"), "utf8");

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS scrapeverse_collector_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        collector_id varchar(100) NOT NULL,
        collection_id varchar(120),
        source_url text NOT NULL,
        started_at timestamptz NOT NULL,
        completed_at timestamptz,
        status varchar(30) NOT NULL,
        rows_received integer DEFAULT 0 NOT NULL,
        rows_valid integer DEFAULT 0 NOT NULL,
        completeness_rate real DEFAULT 0 NOT NULL,
        last_error text,
        self_heal_event_id varchar(120),
        raw_response jsonb,
        created_at timestamptz DEFAULT now() NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS scrapeverse_fii_dii_flows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        source varchar(80) NOT NULL,
        source_url text NOT NULL,
        data_as_of date NOT NULL,
        category varchar(20) NOT NULL,
        segment varchar(30) NOT NULL,
        gross_purchase_crore real NOT NULL,
        gross_sales_crore real NOT NULL,
        net_crore real NOT NULL,
        scraped_at timestamptz NOT NULL,
        collector_id varchar(100) NOT NULL,
        collection_id varchar(120) NOT NULL,
        raw_record_hash varchar(64) NOT NULL,
        validation_status varchar(20) NOT NULL,
        raw_payload jsonb NOT NULL,
        created_at timestamptz DEFAULT now() NOT NULL
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS scrapeverse_collector_runs_collection_id ON scrapeverse_collector_runs USING btree (collection_id)`);

    // These alterations are already present in this local database, but IF NOT EXISTS
    // keeps the repair safe for a partially initialized database.
    await client.query(`ALTER TABLE fundamental_snapshots ALTER COLUMN filed_date TYPE timestamptz`);
    await client.query(`ALTER TABLE fundamental_snapshots ALTER COLUMN fetched_at TYPE timestamptz`);
    await client.query(`ALTER TABLE fundamental_snapshots ALTER COLUMN fetched_at SET DEFAULT now()`);
    await client.query(`ALTER TABLE learning_metrics ALTER COLUMN updated_at TYPE timestamptz`);
    await client.query(`ALTER TABLE learning_metrics ALTER COLUMN updated_at SET DEFAULT now()`);
    await client.query(`ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS decision_trace jsonb`);
    await client.query(`ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS activated_at timestamptz`);
    await client.query(`ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS outcome_verified_at timestamptz`);
    await client.query(`ALTER TABLE rejected_candidates ADD COLUMN IF NOT EXISTS decision_trace jsonb`);

    await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);

    for (const entry of journal.entries) {
      const sql = readFileSync(resolve(migrationsDir, `${entry.tag}.sql`), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         SELECT $1, $2
         WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = $2)`,
        [hash, entry.when],
      );
    }

    await client.query("COMMIT");
    console.log(JSON.stringify({ repaired: true, appliedMigration: "0012_chubby_doctor_faustus", migrationHash: createHash("sha256").update(migrationSql).digest("hex") }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
