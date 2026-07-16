const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres:postgres@localhost:5433/upstox_bot' });
client.connect().then(async () => {
  const res = await client.query("SELECT * FROM intraday_signals WHERE symbol = 'ABCAPITAL' ORDER BY created_at DESC LIMIT 1");
  console.log(JSON.stringify(res.rows, null, 2));
  client.end();
});
