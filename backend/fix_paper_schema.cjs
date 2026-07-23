const { Client } = require('pg');
require('./load-env.cjs');
const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/mimir' });

(async () => {
  await client.connect();

  // Root cause: migration 0005's context_data ALTER never ran on this DB,
  // so every paper ENTRY transaction failed and rolled back.
  await client.query(`ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS context_data jsonb`);
  console.log('paper_orders.context_data: ensured');

  // Verify hot-path tables against what the code writes today.
  const expect = {
    paper_orders: ['id','suggestion_id','symbol','direction','order_type','quantity','price','status','context_data','executed_at'],
    paper_positions: ['id','suggestion_id','symbol','direction','quantity','avg_entry_price','status','realized_pnl','unrealized_pnl','trailing_stop_loss','created_at','closed_at'],
    paper_accounts: ['id','user_id','balance','starting_balance','allocated_margin','created_at','updated_at'],
    live_orders: ['id','suggestion_id','symbol','direction','order_type','quantity','price','status','status_message','broker_order_id','placed_at','updated_at'],
    suggestions: ['id','symbol','direction','trade_type','setup_type','entry_price','stop_loss','target_1','risk_reward','confidence','status','feature_vector','signal_factors','expires_at','generated_at'],
  };
  for (const [table, cols] of Object.entries(expect)) {
    const r = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
    const have = new Set(r.rows.map(x => x.column_name));
    const missing = cols.filter(c => !have.has(c));
    console.log(table + ':', missing.length ? 'MISSING -> ' + missing.join(', ') : 'ok');
  }

  // Paper account was created when tradingCapital was 10,000; config is now
  // 500,000. No orders/positions exist yet, so realigning is loss-free.
  const upd = await client.query(
    `UPDATE paper_accounts
     SET balance = '500000.00', starting_balance = '500000.00', updated_at = now()
     WHERE allocated_margin = '0.00'
       AND NOT EXISTS (SELECT 1 FROM paper_orders)
       AND NOT EXISTS (SELECT 1 FROM paper_positions)
     RETURNING balance, starting_balance`);
  console.log('paper_accounts realigned to config capital:', upd.rows.length ? upd.rows : 'skipped (history exists)');

  await client.end();
})().catch(e => { console.error(e.message); process.exit(1); });
