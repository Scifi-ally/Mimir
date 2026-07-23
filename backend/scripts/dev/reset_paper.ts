import { db } from "../../db/src";
import { tradingConfigTable } from "../../db/src/schema/trading_config";
import { paperAccountsTable } from "../../db/src/schema/paper_trading";

async function run() {
  const [config] = await db.select().from(tradingConfigTable).limit(1);
  if (!config) return;
  await db.update(paperAccountsTable).set({
    balance: config.tradingCapital,
    startingBalance: config.tradingCapital
  });
  console.log("Updated paper account to", config.tradingCapital);
  process.exit(0);
}

run().catch(console.error);
