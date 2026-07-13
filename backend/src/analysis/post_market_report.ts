import { db } from "../../db/src";
import { dailyReportsTable } from "../../db/src/schema/reports";
import { suggestionsTable } from "../../db/src/schema/suggestions";
import { paperPositionsTable } from "../../db/src/schema/paper_trading";
import { gte } from "drizzle-orm";
import { todayStartUTC } from "../lib/ist-time";
import { logger } from "../lib/logger";
import { getAlertHistory } from "./alerts";

export async function generateDailyReport() {
  try {
    const today = todayStartUTC();
    const dateStr = today.toISOString().split("T")[0];

    // Fetch top suggestions
    const suggestions = await db.select().from(suggestionsTable)
      .where(gte(suggestionsTable.generatedAt, today));

    // Fetch paper trades
    const trades = await db.select().from(paperPositionsTable)
      .where(gte(paperPositionsTable.createdAt, today));

    // Fetch alerts
    const alerts = await getAlertHistory();
    const todaysAlerts = alerts.filter(a => new Date(a.timestamp) >= today);

    let reportContent = `# Mimir Daily Market Report - ${dateStr}\n\n`;
    
    reportContent += `## 🚀 Top Signals Generated (${suggestions.length})\n`;
    for (const sug of suggestions.slice(0, 10)) {
      reportContent += `- **${sug.symbol}** (${sug.direction}): Entry ${sug.entryPrice} | Score: ${sug.confidence || sug.aiScore || "N/A"}\n`;
    }

    reportContent += `\n## 📈 Paper Trades Executed (${trades.length})\n`;
    let totalPnl = 0;
    for (const trade of trades) {
      const pnl = Number(trade.realizedPnl) + Number(trade.unrealizedPnl);
      totalPnl += pnl;
      reportContent += `- **${trade.symbol}** (${trade.direction}): Qty ${trade.quantity} | PnL: ₹${pnl.toFixed(2)}\n`;
    }
    reportContent += `\n**Total Estimated PnL Today:** ₹${totalPnl.toFixed(2)}\n`;

    reportContent += `\n## 🔔 Key Intraday Alerts\n`;
    for (const alert of todaysAlerts.slice(0, 15)) {
      reportContent += `- [${alert.type}] **${alert.symbol}**: ${alert.message}\n`;
    }

    const summary = `Generated ${suggestions.length} signals, executed ${trades.length} paper trades with ₹${totalPnl.toFixed(2)} PnL.`;

    await db.insert(dailyReportsTable).values({
      date: dateStr,
      summary,
      content: reportContent
    }).onConflictDoUpdate({
      target: dailyReportsTable.date,
      set: { summary, content: reportContent }
    });

    logger.info(`Generated daily report for ${dateStr}`);
  } catch (err) {
    logger.error({ err }, "Failed to generate daily report");
  }
}
