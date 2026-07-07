import { db, suggestionsTable } from "../backend/db/src";
import { sql } from "drizzle-orm";

async function run() {
  console.log("Deleting duplicate suggestions...");
  
  // Delete suggestions that are duplicates generated today
  const query = sql`
    DELETE FROM suggestions
    WHERE id NOT IN (
      SELECT min(id)
      FROM suggestions
      WHERE generated_at >= current_date
      GROUP BY symbol
    )
    AND generated_at >= current_date;
  `;
  
  await db.execute(query);
  console.log("Done");
  process.exit(0);
}

run().catch(console.error);
