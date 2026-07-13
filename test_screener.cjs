const http = require('http');

const data = JSON.stringify({
  symbol: "ALL",
  targetType: "CUSTOM",
  outputName: "Test",
  timeframe: "15m",
  conditions: {
    type: "AND",
    rules: [{ type: "CONDITION", indicatorA: "CLOSE", operator: ">", indicatorB: "EMA20" }]
  },
  scheduleMode: "MARKET_OPEN"
});

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/screener',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log('Response:', res.statusCode, body));
});

req.on('error', e => console.error(e));
req.write(data);
req.end();
