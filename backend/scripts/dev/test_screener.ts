import { runCustomScreener } from "./src/analysis/custom_screener_engine";
import { db } from "../db/src";
import { customScreenerTable } from "../db/src/schema/custom_screener";

async function main() {
  console.log("Starting screener run...");
  const screeners = await db.select().from(customScreenerTable);
  console.log("Found screeners:", screeners.length);
  
  try {
    await runCustomScreener();
    console.log("Screener run complete.");
  } catch (err) {
    console.error("Error running screener:", err);
  }
  process.exit(0);
}

main();
