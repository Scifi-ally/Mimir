import { db, rejectedCandidatesTable } from "../src/db";
import { eq } from "drizzle-orm";

async function main() {
  const rejected = await db.select().from(rejectedCandidatesTable).where(eq(rejectedCandidatesTable.symbol, "GANDHAR"));
  console.log(`Found ${rejected.length} rejection reasons for GANDHAR:`);
  for (const r of rejected) {
    console.log(`- ${r.createdAt}: ${r.setupType} (${r.direction}) -> ${r.reason}`);
  }
  process.exit(0);
}
main().catch(console.error);
