import "dotenv/config";
import pkg from 'pg';
const { Client } = pkg;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const res = await client.query(`SELECT symbol, close FROM historical_data WHERE symbol = 'ABCAPITAL' ORDER BY date DESC LIMIT 5;`);
  console.log(res.rows);
  await client.end();
}
main().catch(console.error);
