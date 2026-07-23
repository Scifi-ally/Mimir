import { upstoxHeadlessAuth } from "./src/upstox/headless_auth";
import { initConfigFromDb } from "./src/config";

async function run() {
  await initConfigFromDb(); // Ensure config is loaded
  console.log("Starting headless begin...");
  try {
    const res = await upstoxHeadlessAuth.begin("trading");
    console.log("Begin result:", res);
  } catch (e) {
    console.error("Error in begin:", e);
  }
  process.exit(0);
}

run();
