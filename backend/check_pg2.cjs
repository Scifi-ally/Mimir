const { Client } = require('pg');
const client = new Client({ connectionString: 'postgres://postgres:postgres@localhost:5432/mimir_dev' });
client.connect().then(() => {
  return client.query("SELECT symbol, close FROM historical_data WHERE symbol = 'ABCAPITAL' ORDER BY date DESC LIMIT 5;");
}).then(res => {
  console.log(res.rows);
  return client.end();
}).catch(console.error);
