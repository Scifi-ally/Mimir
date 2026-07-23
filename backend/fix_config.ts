import { updateConfig } from "./src/config";

async function run() {
  try {
    await updateConfig({ upstoxRedirectUri: "http://localhost:5000/api/system/auth-callback" });
    console.log("Config updated successfully.");
  } catch (err) {
    console.error("Failed to update config:", err);
  }
  process.exit(0);
}

run();
