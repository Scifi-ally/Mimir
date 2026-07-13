const { Client } = require('pg');
require('dotenv').config();
const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/mimir' });
client.connect().then(() => client.query("SELECT count(*), symbol FROM suggestions WHERE status='ACTIVE' GROUP BY symbol")).then(res => console.log(res.rows)).catch(console.error).finally(() => client.end());
