import "../load-env.cjs";
import { db, tradingConfigTable, suggestionsTable } from "../db/src";
import { eq, inArray, sql } from "drizzle-orm";
import { updateConfig } from "../src/config";
import { logger } from "../src/lib/logger";

async function run() {
  try {
    logger.info("Applying hardened risk config to database...");
    
    try {
      await db.execute(sql`ALTER TABLE trading_config ADD COLUMN discord_webhook_url text;`);
      await db.execute(sql`ALTER TABLE trading_config ADD COLUMN telegram_bot_token text;`);
      await db.execute(sql`ALTER TABLE trading_config ADD COLUMN telegram_chat_id text;`);
    } catch (e) {
      logger.info("Columns already exist or error altering table", e);
    }

    // 1. Update the active trading_config in the database
    await updateConfig({
      minSuggestionScore: 7.5,
      minMtfConfluencePct: 75,
      minAutoConfidencePct: 80,
      minRiskReward: 1.8,
      maxSameDirectionOpenPositions: 2,
    });
    
    logger.info("Database config updated with hardened thresholds.");

    // 2. Clear out any existing suggestions that were generated under relaxed criteria
    const result = await db.update(suggestionsTable)
      .set({ status: "REJECTED", aiReasoning: "[SYSTEM] Rejected due to stricter risk gates being enabled." })
      .where(inArray(suggestionsTable.status, ["ACTIVE", "PENDING"]));
    
    logger.info(`Cleared active/pending suggestions from the database.`);
    
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Failed to apply hardened config");
    process.exit(1);
  }
}

run();
