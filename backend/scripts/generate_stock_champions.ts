/**
 * GENERATE PER-STOCK STRATEGY CHAMPIONS MATRIX REPORT
 * ─────────────────────────────────────────────────────────────────────────────
 * Executes systematic backtests for every liquid NSE instrument across all
 * quantitative strategy families, assigns each stock's undisputed Champion Strategy,
 * saves the profiles to backend/data/stock_strategy_champions.json, and prints
 * an institutional ranking table.
 *
 * Run: npx tsx backend/scripts/generate_stock_champions.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { computeAndSaveStockStrategyMatrix, getAllStockChampions } from "../src/analysis/stock_strategy_matrix";

async function main() {
  console.log("================================================================================");
  console.log("       MIMIR QUANT LAB — PER-STOCK SYSTEMATIC STRATEGY CHAMPIONS MATRIX         ");
  console.log("================================================================================\n");

  const start = Date.now();
  const champions = await computeAndSaveStockStrategyMatrix();
  const durationSec = ((Date.now() - start) / 1000).toFixed(1);

  const stockList = Object.values(champions);
  console.log(`\nSuccessfully evaluated and generated strategy profiles for ${stockList.length} liquid NSE instruments in ${durationSec}s.\n`);

  // Print top champions summary table
  const tableData = stockList.slice(0, 35).map((p, idx) => ({
    "#": idx + 1,
    Symbol: p.symbol,
    "Champion Strategy": p.championStrategy.strategyName.slice(0, 36),
    Family: p.championStrategy.family,
    Trades: p.championStrategy.trades,
    "Win Rate": `${p.championStrategy.winRatePct}%`,
    "Profit Factor": p.championStrategy.profitFactor,
    "Net PnL (₹)": `₹${p.championStrategy.netPnLInr.toLocaleString("en-IN")}`,
    "Affinity Boost": `+${p.affinityWeight}x`,
  }));

  console.table(tableData);

  // Generate Markdown report
  mkdirSync(resolve("docs"), { recursive: true });
  const mdPath = resolve("docs/stock-strategy-champions-report.md");

  const rows = stockList.map((p, idx) => {
    const c = p.championStrategy;
    return `| ${idx + 1} | **${p.symbol}** | \`${c.strategyId}\` | ${c.strategyName} | ${c.family} | ${c.trades} | **${c.winRatePct}%** | **${c.profitFactor}** | +${c.expectancyPct}% | ₹${c.netPnLInr.toLocaleString("en-IN")} | ${p.preferredIndicators.join(", ")} | +${p.affinityWeight}x |`;
  }).join("\n");

  const mdContent = `# Institutional Per-Stock Strategy Champions & Factor Affinity Matrix
*Generated on: ${new Date().toISOString()}*
*Execution Engine: Mimir Quantitative Strategy Lab*

---

## Overview

In quantitative trading, broad market backtests obscure ticker-specific microstructural edges:
- **Momentum names** (e.g., Tata Motors, ICICI Bank) respect Donchian & Supertrend expansions.
- **Mean-reverting defensives** (e.g., ITC, TCS, HUL) excel on deep RSI oversold absorption.
- **High-beta institutional leaders** (e.g., Reliance, HDFC Bank) print consistent edges on EMA 5/50 pullbacks and 5-factor Matrix Ensembles.

This engine tests the strategy matrix for **every single NSE stock**, determines the optimal indicator setup for each ticker, and feeds dynamic weightage into Mimir's live scanner and signal ranker.

---

## Per-Stock Champion Strategies (NSE Universe)

| # | Stock Symbol | Champion Strategy ID | Strategy Name | Factor Family | Trades | Win Rate | Profit Factor | Net Expectancy | Net PnL (₹) | Preferred Indicators | Live Weight Boost |
| :- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${rows}

---

## Live Scanning Integration

When a stock is scanned by \`stock_scanner\` or selected in Mimir's UI:
1. **Dynamic Quality Score Boost**: Candidates matching the stock's proven champion receive a \`+0.5\` to \`+0.8\` quality score bonus in \`scoreSetupQuality\`.
2. **Confidence Calibration**: \`signal_generator\` adds up to \`+15 pts\` of confidence based on the stock's historical Profit Factor and Win Rate.
3. **Trader Transparency**: The UI Detail Panel displays the exact historical champion strategy, win rate, and profit factor for that specific stock.
`;

  writeFileSync(mdPath, mdContent, "utf-8");
  console.log(`\nDetailed Markdown report saved to: ${mdPath}`);
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
