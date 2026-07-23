import { chromium } from "playwright";
import { getAuthorizationUrl } from "./src/upstox/auth";
import crypto from "crypto";
import fs from "fs";

async function run() {
  const type = "trading";
  const authState = crypto.randomBytes(24).toString("hex") + "_" + type;
  const url = getAuthorizationUrl(authState, type);
  
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  console.log("Going to URL:", url);
  await page.goto(url, { waitUntil: "networkidle" });
  
  console.log("Dumping DOM...");
  const dom = await page.content();
  fs.writeFileSync("upstox_login.html", dom);
  console.log("DOM saved to upstox_login.html");
  
  await browser.close();
}

run().catch(console.error);
