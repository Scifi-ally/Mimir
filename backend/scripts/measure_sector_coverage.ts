/**
 * Measure sector coverage with the real loader logic over the live instrument
 * master, so the number reflects the code path rather than a reimplementation.
 *
 * Usage: npx tsx backend/scripts/measure_sector_coverage.ts
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  classifyBySymbol,
  CURATED_SECTOR_BY_SYMBOL,
  isTradableEquityInstrument,
  type StockSector,
} from "../src/analysis/stock_scanner";

interface NseInstrument {
  instrument_key?: string;
  trading_symbol?: string;
  short_name?: string;
  name?: string;
}

const master: NseInstrument[] = JSON.parse(
  gunzipSync(readFileSync("backend/NSE.json.gz")).toString("utf-8"),
);
const equities = master.filter((i) => isTradableEquityInstrument(i));

// Mirrors the loader in stock_scanner.ts, including the short_name/name fix.
function classify(inst: NseInstrument): StockSector {
  const symbol = (inst.trading_symbol ?? "").trim();
  const fallbackName = (inst.short_name ?? "").trim() || (inst.name ?? "").trim() || symbol;
  const fullName = `${inst.short_name ?? ""} ${inst.name ?? ""}`.trim() || fallbackName;
  const curated = symbol ? CURATED_SECTOR_BY_SYMBOL.get(symbol) : undefined;
  const bySymbol = symbol ? classifyBySymbol(symbol) : null;
  if (curvedFallback(curated)) return curated;
  if (bySymbol) return bySymbol;
  return classifyByName(fullName);
}
function curvedFallback(v: StockSector | undefined): v is StockSector {
  return Boolean(v);
}

/** Same rules as mapSectorFromName, re-declared so the measurement is standalone. */
function classifyByName(name: string): StockSector {
  const n = name.toLowerCase();
  if (n.includes("bank")) return "Banks";
  if (/finance|capital|investment|financial|insurance|asset management/.test(n)) return "Financial Services";
  if (/tech|software|info|computer|it | data|consult/.test(n)) return "IT";
  if (/pharma|health|drug|hospital|biotech|laborator/.test(n)) return "Pharma";
  if (/steel|metal|mining|iron|alumin/.test(n)) return "Metals";
  if (/power|energy|oil|gas|petroleum|refiner|electric/.test(n)) return "Energy";
  if (/auto|motor|tyre|tire|automobile/.test(n)) return "Auto";
  if (/cement|construction material/.test(n)) return "Cement";
  if (/telecom|communication|cable/.test(n)) return "Telecom";
  if (/infrastructure|construction|engineering|capital goods|realty|real estate|property|shipping|rail|transport|aviation|logistics/.test(n)) return "Infrastructure";
  if (/paint/.test(n)) return "Paints";
  if (/media|entertainment|broadcast|publishing/.test(n)) return "Media";
  if (/chemical|fertilis|fertiliz|agriculture|agro/.test(n)) return "Chemicals";
  if (/hotel|tourism|travel|hospitality/.test(n)) return "Consumer";
  if (/food|dairy|consumer|retail|fmcg|beverage|brew|textile|cotton|garment|apparel/.test(n)) return "FMCG";
  if (/paper|packaging|plywood/.test(n)) return "Cement";
  return "Other";
}

const counts = new Map<StockSector, number>();
let resolved = 0;
for (const inst of equities) {
  const s = classify(inst);
  if (s !== "Other") resolved += 1;
  counts.set(s, (counts.get(s) ?? 0) + 1);
}

const total = equities.length;
const other = counts.get("Other") ?? 0;
console.log(`tradable equities        : ${total}`);
console.log(`resolved to a real sector: ${resolved}  (${((resolved / total) * 100).toFixed(1)}%)`);
console.log(`still "Other"            : ${other}  (${((other / total) * 100).toFixed(1)}%)`);
console.log("");
console.log("spread:");
[...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  ${((v / total) * 100).toFixed(1)}%`);
});