import { batchInference } from "./src/analysis/ai_client";

async function test() {
  console.log("Starting batchInference test with <55 candles...");
  const dummyCandles = Array.from({ length: 30 }).map((_, i) => [
    100 + i, 102 + i, 98 + i, 101 + i, 1000
  ]);
  
  try {
    const results = await batchInference([{
      symbol: "EIEL",
      ohlcv: dummyCandles,
      features: {}
    }]);
    
    console.log("Results size:", results.size);
    const result = results.get("EIEL");
    console.log("Result:", result);
  } catch (err) {
    console.error("batchInference threw:", err);
  }
}

test().then(() => process.exit(0)).catch(console.error);
