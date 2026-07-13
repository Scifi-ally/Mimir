const db = require('better-sqlite3')('backend/sqlite.db');
const rows = db.prepare("SELECT id, symbol, status FROM suggestions WHERE status = 'ACTIVE'").all();
console.log(rows);
