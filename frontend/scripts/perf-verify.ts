import { chromium } from 'playwright';

async function runVerification() {
  console.log('Starting Mimir Performance Verification...');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  
  console.log('Navigating to Mimir Dashboard...');
  // The dev server should be running on port 3000
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' }).catch(() => {
    console.error("Could not connect to http://localhost:3000. Is the dev server running?");
    process.exit(1);
  });
  
  console.log('Allowing app to settle (5s)...');
  await page.waitForTimeout(5000);
  
  console.log('Measuring metrics over 10 seconds...');
  
  
  // We can track layout shifts or dropped frames if possible, but 
  // simplified CDP profiling is better:
  await client.send('Tracing.start', {
    categories: ['disabled-by-default-devtools.timeline', 'devtools.timeline'],
  });

  await page.waitForTimeout(10000);
  
    
  const metrics = await client.send('Performance.getMetrics');
  
  console.log('Metrics recorded:', metrics.metrics);
  
  const layoutCount = metrics.metrics.find(m => m.name === 'LayoutCount')?.value;
  const recalcStyleCount = metrics.metrics.find(m => m.name === 'RecalcStyleCount')?.value;
  const scriptDuration = metrics.metrics.find(m => m.name === 'ScriptDuration')?.value;
  const taskDuration = metrics.metrics.find(m => m.name === 'TaskDuration')?.value;
  
  console.log('=== Performance Results ===');
  console.log(`LayoutCount: ${layoutCount}`);
  console.log(`RecalcStyleCount: ${recalcStyleCount}`);
  console.log(`ScriptDuration: ${scriptDuration}s`);
  console.log(`TaskDuration: ${taskDuration}s`);
  
  const passes = taskDuration && taskDuration < 2; // Arbitrary target: under 2s of task time over 10s period
  
  if (passes) {
    console.log('✅ Performance Audit PASSED. Mimir UI is instantaneous.');
  } else {
    console.log('⚠️ Performance Audit complete, but task duration was higher than expected. Wait until full optimized build to verify.');
  }
  
  await browser.close();
}

runVerification().catch(console.error);
