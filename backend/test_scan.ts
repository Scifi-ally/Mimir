import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.resolve(__dirname, "../.env") });

async function main() {
  console.log("Starting test scan...");
  const { runOvernightScanner } = await import("./src/analysis/overnight_scanner.ts");
  await runOvernightScanner(true, true, "manual");
  console.log("Done.");
  process.exit(0);
}
main().catch(console.error);
