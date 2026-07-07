import { db } from './src/index.js';
import { overnightWatchlistTable } from './src/schema.js';
import { eq } from 'drizzle-orm';

async function main() {
  const d22 = await db.select().from(overnightWatchlistTable).where(eq(overnightWatchlistTable.forDate, '2026-06-22'));
  const d19 = await db.select().from(overnightWatchlistTable).where(eq(overnightWatchlistTable.forDate, '2026-06-19'));
  console.log('2026-06-22:', d22.map(i => i.category));
  console.log('2026-06-19:', d19.map(i => i.category));
}
main().then(() => process.exit(0)).catch(console.error);
