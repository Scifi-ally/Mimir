/**
 * Expectancy report CLI — prints realized edge per trade (R, after costs).
 *
 *   npx tsx scripts/expectancy_report.ts [--days 60]
 */
import { buildExpectancyReport, type BucketStats } from "../src/suggestions/expectancy";
import { pool } from "../db/src";

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

function fmtBucket(name: string, b: BucketStats): string {
  if (b.trades === 0) return `  ${name.padEnd(28)} —`;
  return [
    `  ${name.padEnd(28)}`,
    `n=${String(b.trades).padStart(4)}`,
    `win%=${b.winRatePct != null ? String(b.winRatePct).padStart(5) : "  n/a"}`,
    `avgW=${b.avgWinR != null ? b.avgWinR.toFixed(2).padStart(6) : "   n/a"}R`,
    `avgL=${b.avgLossR != null ? b.avgLossR.toFixed(2).padStart(6) : "   n/a"}R`,
    `exp=${b.expectancyR != null ? b.expectancyR.toFixed(3).padStart(7) : "    n/a"}R`,
    `PF=${b.profitFactor != null ? b.profitFactor.toFixed(2).padStart(5) : "  n/a"}`,
    `PnL=₹${b.totalPnlInr.toFixed(0)}`,
  ].join("  ");
}

async function main() {
  const days = argNum("days", 60);
  const r = await buildExpectancyReport(days);

  console.log(`\nEXPECTANCY REPORT — last ${r.windowDays} days (from ${r.from.slice(0, 10)})`);
  console.log("═".repeat(100));
  console.log(`Closed trades: ${r.totalClosed}   excluded (no pnl): ${r.excludedNoPnl}   excluded (no risk): ${r.excludedNoRisk}\n`);

  console.log("OVERALL");
  console.log(fmtBucket("all trades", r.overall));

  const sections: Array<[string, Record<string, BucketStats>]> = [
    ["BY SETUP", r.bySetup],
    ["BY REGIME", r.byRegime],
    ["BY DIRECTION", r.byDirection],
  ];
  for (const [title, buckets] of sections) {
    console.log(`\n${title}`);
    const entries = Object.entries(buckets).sort((a, b) => (b[1].expectancyR ?? -99) - (a[1].expectancyR ?? -99));
    for (const [k, b] of entries) console.log(fmtBucket(k, b));
  }

  console.log(`\nVERDICT: ${r.verdict}\n`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
