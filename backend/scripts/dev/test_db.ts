import { db } from "./db/src";
import { suggestionsTable } from "./db/src/schema";
import { desc } from "drizzle-orm";

async function main() {
  try {
    const suggestions = await db.select()
      .from(suggestionsTable)
      .orderBy(desc(suggestionsTable.generatedAt))
      .limit(5);
    
    console.log("Latest suggestions:");
    suggestions.forEach(s => {
      console.log(`- ${s.symbol} at ${s.generatedAt} (Status: ${s.status})`);
    });
  } catch (e) {
    console.error("DB Error:", e);
  }
}

main();
