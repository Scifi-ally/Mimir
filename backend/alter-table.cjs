const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });
require('dotenv').config({ path: '.env', override: false });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/upstox_bot'
});

async function run() {
  try {
    await pool.query(`
      ALTER TABLE "custom_screener" ADD COLUMN IF NOT EXISTS "target_type" varchar(50) NOT NULL DEFAULT 'ALL';
      ALTER TABLE "custom_screener" ADD COLUMN IF NOT EXISTS "output_name" varchar(100);
      ALTER TABLE "custom_screener" ADD COLUMN IF NOT EXISTS "conditions" jsonb;
      ALTER TABLE "custom_screener" ADD COLUMN IF NOT EXISTS "schedule_mode" varchar(30) NOT NULL DEFAULT 'MARKET_OPEN';
      ALTER TABLE "custom_screener" ADD COLUMN IF NOT EXISTS "schedule_time" varchar(5);
      
      ALTER TABLE "custom_screener" ALTER COLUMN "indicator_a" DROP NOT NULL;
      ALTER TABLE "custom_screener" ALTER COLUMN "operator" DROP NOT NULL;
      ALTER TABLE "custom_screener" ALTER COLUMN "indicator_b" DROP NOT NULL;
      
      ALTER TABLE "custom_screener_targets" ADD COLUMN IF NOT EXISTS "screener_id" integer REFERENCES "custom_screener"("id") ON DELETE cascade;
    `);
    console.log("Table altered successfully");
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
