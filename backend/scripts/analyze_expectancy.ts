/**
 * Where does the expectancy actually leak?
 *
 * The ranker cannot rescue a negative-expectancy base, and take-all expectancy
 * on 5y of data is -0.445%/trade. Before tuning models, find out whether the
 * loss is concentrated in specific setups / directions / horizons — that is
 * actionable, whereas "the ranker has AUC 0.58" is not.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Row {
  ts: string;
  symbol: string;
  setupType: string;
  direction: string;
  features: number[];
  label: number;
  retPct: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, "..", "data", "ranker_train.jsonl");
const rows: Row[] = readFileSync(file, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);

console.log(`rows=${rows.length}  span=${rows[0]!.ts.slice(0, 10)} .. ${rows[rows.length - 1]!.ts.slice(0, 10)}\n`);

function report(title: string, group: (r: Row) => string, keys?: string[]) {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = group(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  const all = rows.map((r) => r.retPct);
  const overall = all.reduce((a, b) => a + b, 0) / all.length;
  console.log(`=== ${title} ===`);
  console.log(`  ${"group".padEnd(22)} ${"n".padStart(6)} ${"exp%".padStart(8)} ${"win%".padStart(7)} ${"total%".padStart(9)}`);
  for (const k of [...m.keys()].sort()) {
    const g = m.get(k)!;
    if (keys && !keys.includes(k)) continue;
    const exp = g.reduce((a, r) => a + r.retPct, 0) / g.length;
    const win = (g.filter((r) => r.label === 1).length / g.length) * 100;
    const tot = g.reduce((a, r) => a + r.retPct, 0);
    console.log(`  ${k.padEnd(22)} ${String(g.length).padStart(6)} ${exp.toFixed(3).padStart(8)} ${win.toFixed(1).padStart(7)} ${tot.toFixed(0).padStart(9)}`);
  }
  console.log(`  ${"ALL".padEnd(22)} ${String(rows.length).padStart(6)} ${overall.toFixed(3).padStart(8)}\n`);
}

report("by setup type", (r) => r.setupType);
report("by direction", (r) => r.direction);

// Per-symbol: are losses concentrated in a few names, or systemic?
const perSym = new Map<string, Row[]>();
for (const r of rows) {
  if (!perSym.has(r.symbol)) perSym.set(r.symbol, []);
  perSym.get(r.symbol)!.push(r);
}
const symStats = [...perSym.entries()]
  .map(([s, g]) => ({
    s,
    n: g.length,
    exp: g.reduce((a, r) => a + r.retPct, 0) / g.length,
  }))
  .sort((a, b) => b.exp - a.exp);
console.log("=== best 8 symbols (expectancy %) ===");
for (const x of symStats.slice(0, 8)) console.log(`  ${x.s.padEnd(14)} n=${String(x.n).padStart(5)} exp=${x.exp.toFixed(3)}`);
console.log("\n=== worst 8 symbols (expectancy %) ===");
for (const x of symStats.slice(-8)) console.log(`  ${x.s.padEnd(14)} n=${String(x.n).padStart(5)} exp=${x.exp.toFixed(3)}`);

const pos = symStats.filter((x) => x.exp > 0).length;
console.log(`\nsymbols with positive expectancy: ${pos}/${symStats.length}`);

// Is the loss driven by TIMEOUT rows (random 5-day drift) or by real stops?
const byLabel = new Map<number, Row[]>();
for (const r of rows) {
  if (!byLabel.has(r.label)) byLabel.set(r.label, []);
  byLabel.get(r.label)!.push(r);
}
console.log("\n=== by label (1 = hit target before stop) ===");
for (const [lbl, g] of byLabel) {
  const exp = g.reduce((a, r) => a + r.retPct, 0) / g.length;
  console.log(`  label=${lbl}  n=${String(g.length).padStart(6)}  meanExp=${exp.toFixed(3)}%  share=${((g.length / rows.length) * 100).toFixed(1)}%`);
}
