const { Client } = require('pg');
require('./load-env.cjs');
const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/mimir' });

(async () => {
  await client.connect();
  const sug = await client.query(
    `SELECT id, symbol, direction, status, setup_type, entry_price, generated_at, expires_at
     FROM suggestions ORDER BY generated_at DESC LIMIT 15`);
  console.log('--- Latest suggestions ---');
  for (const r of sug.rows) console.log(r.generated_at?.toISOString(), r.symbol, r.direction, r.status, r.setup_type, 'entry=' + r.entry_price, 'expires=' + (r.expires_at ? r.expires_at.toISOString() : 'null'));

  const ord = await client.query(
    `SELECT symbol, direction, order_type, quantity, price, executed_at
     FROM paper_orders ORDER BY executed_at DESC LIMIT 10`);
  console.log('--- Latest paper orders ---');
  for (const r of ord.rows) console.log(r.executed_at?.toISOString(), r.symbol, r.direction, r.order_type, 'qty=' + r.quantity, 'px=' + r.price);

  const pos = await client.query(
    `SELECT symbol, direction, status, quantity, avg_entry_price, created_at
     FROM paper_positions ORDER BY created_at DESC LIMIT 10`);
  console.log('--- Latest paper positions ---');
  for (const r of pos.rows) console.log(r.created_at?.toISOString(), r.symbol, r.direction, r.status, 'qty=' + r.quantity, 'entry=' + r.avg_entry_price);

  const acct = await client.query(`SELECT balance, starting_balance, allocated_margin FROM paper_accounts LIMIT 1`);
  console.log('--- Paper account ---');
  console.log(acct.rows);

  await client.end();
})().catch(e => { console.error(e.message); process.exit(1); });
