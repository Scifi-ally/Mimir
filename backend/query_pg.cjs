const { Client } = require('pg');
require('dotenv').config();
const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/mimir' });
client.connect().then(() => client.query("ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS expected_hold_minutes integer;")).then(res => console.log(res)).catch(console.error).finally(() => client.end());
