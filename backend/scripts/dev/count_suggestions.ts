import { db, suggestionsTable, pool } from "../../db/src";
import { sql } from "drizzle-orm";

async function main() {
  const rows = await db
    .select({
      status: suggestionsTable.status,
      n: sql<number>`count(*)::int`,
      latest: sql<string>`max(generated_at)::text`,
    })
    .from(suggestionsTable)
    .groupBy(suggestionsTable.status);
  console.log(JSON.stringify(rows, null, 2));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
