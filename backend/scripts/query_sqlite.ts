import Database from "better-sqlite3";
const db = new Database("../db/mimir.db");
const rows = db.prepare("SELECT * FROM rejected_candidates WHERE symbol='GANDHAR'").all();
console.log(`Found ${rows.length} rows for GANDHAR`);
console.log(rows);
