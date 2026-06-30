import { checkAIHealth } from "./src/analysis/ai_client";

async function main() {
  console.log("Testing AI Health...");
  try {
    const health = await checkAIHealth();
    console.log("AI Health:", health);
  } catch (e) {
    console.error("AI Service Error:", e);
  }
}

main();
