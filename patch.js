const fs = require('fs');
const file = 'backend/src/analysis/stock_scanner.ts';
let code = fs.readFileSync(file, 'utf8');

// 1. fetchDailyCandles
code = code.replace(
  /async function fetchDailyCandles\([\s\S]*?\): Promise<OHLCV\[\]> \{/m,
  "async function fetchDailyCandles(\n  instrumentKey: string,\n  daysBack = 380,\n  endDate?: string,\n  priority = false\n): Promise<OHLCV[]> {"
);
code = code.replace(
  /const raw = await upstoxClient\.fetchHistoricalCandles\(\s*instrumentKey,\s*"day",\s*toDateStr,\s*fromDate,\s*token,?\s*\);/m,
  "const raw = await upstoxClient.fetchHistoricalCandles(\n      instrumentKey,\n      \"day\",\n      toDateStr,\n      fromDate,\n      token,\n      priority\n    );"
);

// 2. fetchHourlyCandles
code = code.replace(
  /async function fetchHourlyCandles\([\s\S]*?\): Promise<OHLCV\[\]> \{/m,
  "async function fetchHourlyCandles(\n  instrumentKey: string,\n  daysBack = 75,\n  endDate?: string,\n  priority = false\n): Promise<OHLCV[]> {"
);
code = code.replace(
  /const raw = await upstoxClient\.fetchHistoricalCandles\(\s*instrumentKey,\s*"60minute",\s*toDateStr,\s*fromDate,\s*token,?\s*\);/m,
  "const raw = await upstoxClient.fetchHistoricalCandles(\n      instrumentKey,\n      \"60minute\",\n      toDateStr,\n      fromDate,\n      token,\n      priority\n    );"
);

// 3. scanStock
code = code.replace(
  /export async function scanStock\(\s*stock: UniverseStock,\s*niftyCandles\?: OHLCV\[\],\s*scanDate\?: string,\s*\): Promise<ScanResult \| null> \{/m,
  "export async function scanStock(\n  stock: UniverseStock,\n  niftyCandles?: OHLCV[],\n  scanDate?: string,\n  priority = false\n): Promise<ScanResult | null> {"
);
code = code.replace(
  /fetchDailyCandles\(stock\.key, 380, scanDate\),/m,
  "fetchDailyCandles(stock.key, 380, scanDate, priority),"
);
code = code.replace(
  /fetchHourlyCandles\(stock\.key, 75, scanDate\),/m,
  "fetchHourlyCandles(stock.key, 75, scanDate, priority),"
);

// 4. resolveSymbolInsightContext
code = code.replace(
  /export async function resolveSymbolInsightContext\(\s*stock: UniverseStock,\s*niftyCandles\?: OHLCV\[\],\s*\): Promise<SymbolInsightContext \| null> \{/m,
  "export async function resolveSymbolInsightContext(\n  stock: UniverseStock,\n  niftyCandles?: OHLCV[],\n  priority = false\n): Promise<SymbolInsightContext | null> {"
);
code = code.replace(
  /const scan = await scanStock\(stock, niftyCandles\);/m,
  "const scan = await scanStock(stock, niftyCandles, undefined, priority);"
);
code = code.replace(
  /const dailyCandles = await fetchDailyCandles\(stock\.key, 380\);/m,
  "const dailyCandles = await fetchDailyCandles(stock.key, 380, undefined, priority);"
);
code = code.replace(
  /const hourlyCandles = await fetchHourlyCandles\(stock\.key, 75\);/m,
  "const hourlyCandles = await fetchHourlyCandles(stock.key, 75, undefined, priority);"
);

fs.writeFileSync(file, code);
console.log('Modified stock_scanner.ts successfully!');
