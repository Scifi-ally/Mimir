const { Client } = require('pg');
require('./load-env.cjs');
const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/mimir' });
(async () => {
  await client.connect();
  const r = await client.query(`SELECT paper_trading_enabled, trading_mode, trading_capital FROM trading_config WHERE id = 1`);
  console.log(r.rows);
  await client.end();
})().catch(e => { console.error(e.message); process.exit(1); });
