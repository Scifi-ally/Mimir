import { db } from "../../db/src";
import { dailyReportsTable } from "../../db/src/schema/reports";
import { suggestionsTable } from "../../db/src/schema/suggestions";
import { paperPositionsTable } from "../../db/src/schema/paper_trading";
import { marketMetricsTable } from "../../db/src/schema/market_metrics";
import { gte, lte, and, eq, desc } from "drizzle-orm";
import { todayStartUTC, getISTDateStr } from "../lib/ist-time";
import { logger } from "../lib/logger";
import { getAlertHistory } from "./alerts";
import { getMarketState } from "../market_data/market_state";

export async function generateDailyReport(targetDateStr?: string) {
  try {
    const dateStr = targetDateStr ? targetDateStr.trim() : getISTDateStr();
    
    // Determine start and end of date range in UTC
    const dateObj = new Date(dateStr + "T00:00:00.000Z");
    const dayStart = isNaN(dateObj.getTime()) ? todayStartUTC() : new Date(dateObj.setUTCHours(0, 0, 0, 0));
    const dayEnd = isNaN(dateObj.getTime()) ? new Date() : new Date(dateObj.setUTCHours(23, 59, 59, 999));

    // Fetch top suggestions
    const suggestions = await db.select().from(suggestionsTable)
      .where(and(gte(suggestionsTable.generatedAt, dayStart), lte(suggestionsTable.generatedAt, dayEnd)));

    // Fetch paper trades
    const trades = await db.select().from(paperPositionsTable)
      .where(and(gte(paperPositionsTable.createdAt, dayStart), lte(paperPositionsTable.createdAt, dayEnd)));

    // Fetch alerts
    const alerts = await getAlertHistory();
    const todaysAlerts = alerts.filter(a => {
      const t = new Date(a.timestamp);
      return t >= dayStart && t <= dayEnd;
    });

    let mkt = getMarketState();
    
    // If memory state is empty (e.g. server restarted off-hours), fallback to saved market metrics
    if (mkt.niftyPrice === null || mkt.advanceCount === 0) {
      const metric = await db.select().from(marketMetricsTable).orderBy(desc(marketMetricsTable.date)).limit(1);
      if (metric.length > 0) {
        const row = metric[0];
        mkt = {
          ...mkt,
          niftyPrice: row.niftyClose ? parseFloat(row.niftyClose) : 0,
          niftyChangePct: row.niftyChangePct ? parseFloat(row.niftyChangePct) : null,
          indiaVix: row.indiaVixClose ? parseFloat(row.indiaVixClose) : null,
          advanceCount: row.advanceCount || 0,
          declineCount: row.declineCount || 0,
          topSectors: row.strongestSector ? [
            { name: row.strongestSector, changePct: 0, moneyFlowM: 0 },
            { name: row.weakestSector ?? "", changePct: 0, moneyFlowM: 0 }
          ] : []
        };
      }
    }
    
    let reportContent = `# Mimir Daily Market Report - ${dateStr}\n\n`;

    reportContent += `### Market Overview\n\n`;
    reportContent += `| Metric | Value |\n|---|---|\n`;
    reportContent += `| **NIFTY 50** | ${mkt.niftyPrice ? mkt.niftyPrice.toFixed(2) : 'N/A'} ${mkt.niftyChangePct !== null ? `(${mkt.niftyChangePct > 0 ? '+' : ''}${mkt.niftyChangePct.toFixed(2)}%)` : ''} |\n`;
    reportContent += `| **India VIX** | ${mkt.indiaVix ? mkt.indiaVix.toFixed(2) : 'N/A'} |\n`;
    reportContent += `| **Breadth** | ${mkt.advanceCount} Advances / ${mkt.declineCount} Declines |\n`;
    if (mkt.fiiNetInr !== null) {
      reportContent += `| **FII Net** | INR ${mkt.fiiNetInr} Cr |\n`;
    }
    if (mkt.diiNetInr !== null) {
      reportContent += `| **DII Net** | INR ${mkt.diiNetInr} Cr |\n`;
    }
    reportContent += `\n`;

    if (mkt.topSectors && mkt.topSectors.length > 0) {
      reportContent += `### Sector Performance\n\n`;
      const sortedSectors = [...mkt.topSectors].sort((a, b) => b.changePct - a.changePct);
      reportContent += `* **Top Sector:** ${sortedSectors[0].name} (${sortedSectors[0].changePct > 0 ? '+' : ''}${sortedSectors[0].changePct.toFixed(2)}%)\n`;
      reportContent += `* **Weakest Sector:** ${sortedSectors[sortedSectors.length - 1].name} (${sortedSectors[sortedSectors.length - 1].changePct > 0 ? '+' : ''}${sortedSectors[sortedSectors.length - 1].changePct.toFixed(2)}%)\n\n`;
    }

    reportContent += `### Top Signals Generated (${suggestions.length})\n\n`;
    if (suggestions.length === 0) {
      reportContent += `*No signals generated today.*\n`;
    } else {
      for (const sug of suggestions.slice(0, 10)) {
        const dirIcon = sug.direction === 'BUY' ? 'BUY' : 'SELL';
        reportContent += `* **${dirIcon}** **${sug.symbol}** — Entry: **INR ${sug.entryPrice}** | Score: ${sug.confidence || sug.aiScore || "N/A"}\n`;
      }
    }

    reportContent += `\n### Paper Trades Executed (${trades.length})\n\n`;
    let totalPnl = 0;
    if (trades.length === 0) {
      reportContent += `*No paper trades executed today.*\n`;
    } else {
      for (const trade of trades) {
        const pnl = Number(trade.realizedPnl) + Number(trade.unrealizedPnl);
        totalPnl += pnl;
        const pnlStr = pnl >= 0 ? `+INR ${pnl.toFixed(2)}` : `-INR ${Math.abs(pnl).toFixed(2)}`;
        reportContent += `* **${trade.symbol}** (${trade.direction}) — Qty: ${trade.quantity} | PnL: **${pnlStr}**\n`;
      }
    }
    const totalPnlStr = totalPnl >= 0 ? `+INR ${totalPnl.toFixed(2)}` : `-INR ${Math.abs(totalPnl).toFixed(2)}`;
    reportContent += `\n> **Total Estimated PnL Today: ${totalPnlStr}**\n`;

    reportContent += `\n### Key Intraday Alerts\n\n`;
    if (todaysAlerts.length === 0) {
       reportContent += `*No significant alerts today.*\n`;
    } else {
      for (const alert of todaysAlerts.slice(0, 15)) {
        reportContent += `* [${alert.type}] **${alert.symbol}**: ${alert.message}\n`;
      }
    }

    const summary = `Generated ${suggestions.length} signals, executed ${trades.length} paper trades with INR ${totalPnl.toFixed(2)} PnL.`;

    const existing = await db.select().from(dailyReportsTable).where(eq(dailyReportsTable.date, dateStr)).limit(1);
    if (existing.length > 0) {
      await db.update(dailyReportsTable).set({ summary, content: reportContent }).where(eq(dailyReportsTable.date, dateStr));
    } else {
      await db.insert(dailyReportsTable).values({ date: dateStr, summary, content: reportContent });
    }

    logger.info(`Generated daily report for ${dateStr}`);
  } catch (err) {
    logger.error({ err }, "Failed to generate daily report");
  }
}
