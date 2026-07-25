import { db } from './src/index'; 
import { sql } from 'drizzle-orm'; 
db.execute(sql`TRUNCATE TABLE daily_reports`).then(() => {
  console.log('Truncated');
  process.exit(0);
}).catch(console.error);
