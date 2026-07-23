import { db } from "../backend/db/src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  console.log("Creating custom_watchlist table...");
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS custom_watchlist (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        symbol varchar(20) NOT NULL UNIQUE,
        created_at timestamp with time zone NOT NULL DEFAULT now()
      );
    `);
    console.log("Table custom_watchlist created successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Error creating table:", err);
    process.exit(1);
  }
}

main();
