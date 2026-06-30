import puppeteer from 'puppeteer';

async function run() {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  console.log("Navigating to frontend...");
  try {
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 10000 });
  } catch (err: unknown) {
    console.log("Navigation error:", err.message);
  }
  
  console.log("Waiting a bit to let things load...");
  await new Promise(r => setTimeout(r, 3000));
  
  await browser.close();
}

run();
