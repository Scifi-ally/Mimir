import { db, suggestionsTable } from "../backend/db/src";
import { sql } from "drizzle-orm";

async function run() {
  console.log("Deleting duplicate suggestions...");
  
  // Delete suggestions that are duplicates generated today (keep earliest per symbol)
  const query = sql`
    DELETE FROM suggestions
    WHERE generated_at >= current_date
    AND id NOT IN (
      SELECT DISTINCT ON (symbol) id
      FROM suggestions
      WHERE generated_at >= current_date
      ORDER BY symbol, generated_at ASC
    );
  `;
  
  await db.execute(query);
  console.log("Done");
  process.exit(0);
}

run().catch(console.error);
