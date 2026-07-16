import "dotenv/config";
import { db } from "./src/db/index.js";
import { historicalDataTable } from "./src/db/schema.js";
import { eq, desc } from "drizzle-orm";

async function main() {
  const data = await db.select().from(historicalDataTable).where(eq(historicalDataTable.symbol, 'ABCAPITAL')).orderBy(desc(historicalDataTable.date)).limit(5);
  console.log(data);
  process.exit(0);
}
main().catch(console.error);
