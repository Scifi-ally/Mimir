import "./load-env.cjs";
import { db } from "../db/src/index.js";
import { sql } from "drizzle-orm";

async function run() {
  try {
    const res = await db.execute(sql`SELECT 1`);
    console.log("DB connection OK:", res);
  } catch (err) {
    console.error("DB error:", err);
  }
  process.exit(0);
}
run();
