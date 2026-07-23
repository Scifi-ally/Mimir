import { DatabaseSync } from 'node:sqlite';

try {
  const db = new DatabaseSync('../db/mimir.db');
  const count = db.prepare("SELECT count(*) as c FROM candles WHERE symbol='GANDHAR'").get();
  console.log("Candles for GANDHAR in sqlite:", count);
} catch (e) {
  console.log("sqlite error", e.message);
}
