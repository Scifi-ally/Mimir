import { chromium } from "playwright";
import crypto from "crypto";
import fs from "fs";

async function run() {
  const type = "trading";
  const authState = crypto.randomBytes(24).toString("hex") + "_" + type;
  
  // Test with localhost redirect URI
  const client_id = "ff949a1a-8bcb-4262-8122-6c465a1b79d9"; // From .env
  const redirect_uri = "http://localhost:5000/api/system/auth-callback";
  
  const params = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri,
    state: authState,
  });
  const url = `https://api-v2.upstox.com/login/authorization/dialog?${params.toString()}`;
  
  console.log("Going to URL:", url);
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  await page.goto(url, { waitUntil: "networkidle" });
  
  const dom = await page.content();
  fs.writeFileSync("upstox_login_localhost.html", dom);
  console.log("DOM saved to upstox_login_localhost.html");
  
  await browser.close();
}

run().catch(console.error);
