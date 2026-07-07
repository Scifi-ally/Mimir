import { db } from './db/src';
import { sql } from 'drizzle-orm';

async function run() {
  await db.execute(sql`TRUNCATE TABLE signal_outcomes, ai_scores, suggestions, performance_stats CASCADE;`);
  console.log('Truncated all tables!');
  process.exit(0);
}

run().catch(console.error);
