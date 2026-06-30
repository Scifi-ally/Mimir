import { diagnoseScanNullReason } from "./analysis/stock_scanner.js";
import { getEffectiveUniverse } from "./analysis/stock_scanner.js";
import { config } from "dotenv";
config();

async function run() {
  const stocks = await getEffectiveUniverse();
  const reasons: Record<string, number> = {};
  
  console.log(`Diagnosing ${stocks.length} stocks...`);
  
  let i = 0;
  // run sequentially to avoid upstox rate limit (10/sec)
  for (const stock of stocks) {
    const reason = await diagnoseScanNullReason(stock).catch(() => "exception");
    reasons[reason] = (reasons[reason] || 0) + 1;
    
    i++;
    if (i % 100 === 0) console.log(`Processed ${i}/${stocks.length}`);
    await new Promise(r => setTimeout(r, 150)); // ~6 per sec
  }
  
  console.log("Summary of rejections:");
  console.log(reasons);
}

run().catch(console.error).then(() => process.exit(0));
