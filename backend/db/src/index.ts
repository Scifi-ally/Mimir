import "../../load-env.cjs";
import { config as dotenvConfig } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenvConfig({ path: path.resolve(__dirname, "../../.env.local"), override: true });
dotenvConfig({ path: path.resolve(__dirname, "../../.env") });
dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local"), override: true });
dotenvConfig({ path: path.resolve(__dirname, "../../../.env") });

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Reduced from 100 to prevent exhausting connections (Issue #12)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 60000, // 60s timeout to allow heavy bulk queries to queue during I/O spikes
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client", err);
  // Don't exit process, let the pool handle it or reconnect
});

export const db = drizzle(pool, { schema });

export * from "./schema";
