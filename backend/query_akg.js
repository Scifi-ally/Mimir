import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/upstox_bot' });

client.connect().then(() => client.query("SELECT id, symbol, status FROM suggestions WHERE symbol='AKG'"))
  .then(res => console.log(res.rows))
  .catch(console.error)
  .finally(() => client.end());
