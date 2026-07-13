import "../load-env.cjs";
import { config as dotenvConfig } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { logger } from "./lib/logger";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenvConfig({ path: path.resolve(__dirname, "../../.env.local"), override: true });
dotenvConfig({ path: path.resolve(__dirname, "../../.env") });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});

async function runMigrations() {
  console.log("Running database migrations...");
  try {
    const db = drizzle(pool);
    // Since this file runs from dist/migrate.mjs, the migrations folder is in the root of backend/drizzle
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../drizzle") });
    console.log("Database migrations completed successfully.");
    await pool.end();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Migration failed");
    await pool.end();
    process.exit(1);
  }
}

runMigrations();
