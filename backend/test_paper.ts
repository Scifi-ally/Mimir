import { intelligenceBus } from "./src/intelligence/event_bus.js";
import { initPaperEngine } from "./src/trading/paper_engine.js";
import { db } from "../db/src/index.js";
import { paperPositionsTable } from "../db/src/schema/paper_trading.js";
// removed unused import

async function test() {
  await initPaperEngine();
  
  console.log("Emitting mock suggestion...");
  intelligenceBus.publish("suggestionGenerated", {
    suggestion: {
      id: "mock-123",
      instrumentKey: "NSE_EQ|INE123456789",
      symbol: "RELIANCE",
      direction: "BUY",
      setup: "MOCK_SETUP",
      confidence: 80,
      entry: 2500,
      stopLoss: 2450,
      target: 2600,
      riskReward: 2.0,
      reasoning: ["Test reasoning"],
      generatedAt: Date.now(),
      expiresAt: Date.now() + 1000000,
    }
  });

  // Wait for async processing
  await new Promise(r => setTimeout(r, 2000));
  
  const positions = await db.select().from(paperPositionsTable);
  console.log("Positions in DB after mock:", positions.map(p => p.symbol));
  
  process.exit(0);
}

test().catch(console.error);
