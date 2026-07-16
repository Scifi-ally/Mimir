import "dotenv/config";
import { getQuote } from "./src/lib/upstox-client.js";

async function main() {
  const quote = await getQuote("NSE_EQ|INE674K01013");
  console.log(JSON.stringify(quote, null, 2));
}
main().catch(console.error);
