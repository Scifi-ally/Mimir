import { db } from "./db/src/index.ts";
import { suggestionsTable } from "./db/src/schema/suggestions.ts";

async function check() {
  try {
    const suggestions = await db.select().from(suggestionsTable).limit(5);
    console.log("=== SUGGESTIONS ===");
    console.log(suggestions);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
}

check();
