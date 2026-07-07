const fs = require('fs');
const file = 'backend/src/lib/upstox-client.ts';
let code = fs.readFileSync(file, 'utf8');

// fetchLTPForInstruments
code = code.replace(
  /async function fetchLTPForInstruments\([\s\S]*?\): Promise<Record<string, number>> \{/,
  "async function fetchLTPForInstruments(\n    keys: string[],\n    token: string,\n    priority: boolean = false,\n  ): Promise<Record<string, number>> {"
);

code = code.replace(
  /const data = await withRetry\([\s\S]*?,\s*"fetchLTPForInstruments",\s*\);/m,
  "const data = await withRetry(\n            async () => {\n              const url = ${BASE_URL}/market-quote/ltp;\n              const resp = await axios.get(url, {\n                headers: {\n                  Authorization: Bearer ,\n                  Accept: \"application/json\",\n                },\n                params: {\n                  instrument_key: batch.join(\",\"),\n                },\n                timeout: DEFAULT_TIMEOUT,\n              });\n              return resp.data;\n            },\n            \"fetchLTPForInstruments\",\n            DEFAULT_RETRY_CONFIG,\n            priority\n          );"
);

fs.writeFileSync(file, code);
console.log('Modified fetchLTPForInstruments successfully!');
