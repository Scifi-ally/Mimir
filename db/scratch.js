const { db } = require('./src/index.js');
const { overnightWatchlistTable } = require('./src/schema.js');
const { eq } = require('drizzle-orm');

async function main() {
  const d22 = await db.select().from(overnightWatchlistTable).where(eq(overnightWatchlistTable.forDate, '2026-06-22'));
  const d19 = await db.select().from(overnightWatchlistTable).where(eq(overnightWatchlistTable.forDate, '2026-06-19'));
  console.log('2026-06-22:', d22.length);
  console.log('2026-06-19:', d19.length);
}
main().catch(console.error);
