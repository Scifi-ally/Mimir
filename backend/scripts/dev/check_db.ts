import { db } from "../../db/src";
import { tradingConfigTable } from "../../db/src/schema/trading_config";
import { paperAccountsTable } from "../../db/src/schema/paper_trading";

async function run() {
  const [config] = await db.select().from(tradingConfigTable).limit(1);
  const [account] = await db.select().from(paperAccountsTable).limit(1);
  console.log("Config trading_capital:", config?.tradingCapital);
  console.log("Paper account balance:", account?.balance);
  process.exit(0);
}

run().catch(console.error);
