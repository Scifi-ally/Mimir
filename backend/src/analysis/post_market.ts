import { db } from "../../db/src";
import {
  suggestionsTable,
  performanceStatsTable,
  marketMetricsTable,
} from "../../db/src";
import { and, gte, lt } from "drizzle-orm";
import { getMarketState } from "../market_data/market_state";
import { broadcast } from "../ws/websocket_server";
import { logger } from "../lib/logger";
import { getISTDateStr, getISTDayBounds } from "../lib/ist-time";
import { getConfig } from "../config";
import { archiveDailyTicks } from "../market_data/tick_archiver";

export async function savePostMarketData(): Promise<void> {
  const todayIST = getISTDateStr();
  const { start, end } = getISTDayBounds(todayIST);

  logger.info({ date: todayIST }, "Running post-market analysis");

  try {
    const cfg = getConfig();
    // Fetch all of today's suggestions
    const rows = await db
      .select()
      .from(suggestionsTable)
      .where(
        and(
          gte(suggestionsTable.generatedAt, start),
          lt(suggestionsTable.generatedAt, end),
        ),
      );

    const total = rows.length;
    const wins = rows.filter(
      (r) => r.status === "TARGET_1_HIT" || r.status === "TARGET_2_HIT",
    );
    const losses = rows.filter((r) => r.status === "STOP_HIT");
    const expired = rows.filter((r) => r.status === "EXPIRED");
    const closed = [...wins, ...losses];

    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

    const grossProfit = wins.reduce(
      (s, r) => s + (r.pnlInr ? parseFloat(r.pnlInr) : 0),
      0,
    );
    const grossLoss = Math.abs(
      losses.reduce((s, r) => s + (r.pnlInr ? parseFloat(r.pnlInr) : 0), 0),
    );
    const profitFactor =
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    const rrValues = closed
      .map((r) => (r.riskReward ? parseFloat(r.riskReward) : 0))
      .filter((v) => v > 0);
    const avgRr =
      rrValues.length > 0
        ? rrValues.reduce((a, b) => a + b, 0) / rrValues.length
        : 0;

    const totalPnl = rows.reduce(
      (s, r) => s + (r.pnlInr ? parseFloat(r.pnlInr) : 0),
      0,
    );
    const executed = rows.filter((r) => r.status !== "ACTIVE").length;
    const estimatedCosts =
      executed * (cfg.brokeragePerOrderInr * 2) +
      rows.reduce((sum, r) => {
        const entry = parseFloat(r.entryPrice);
        const qty = r.quantity ?? 0;
        return sum + (entry * qty * (cfg.slippageBps / 10000));
      }, 0);
    const netAfterCosts = totalPnl - estimatedCosts;

    // Save performance stats (upsert by date)
    await db
      .insert(performanceStatsTable)
      .values({
        date: todayIST,
        totalSuggestions: total,
        wins: wins.length,
        losses: losses.length,
        expired: expired.length,
        winRate: winRate.toFixed(2),
        profitFactor: Math.min(profitFactor, 999).toFixed(2),
        avgRrRealized: avgRr.toFixed(2),
        totalPnlInr: totalPnl.toFixed(2),
        statsJson: {
          setupBreakdown: computeSetupBreakdown(rows),
          estimatedCostsInr: Math.round(estimatedCosts * 100) / 100,
          netPnlAfterCostsInr: Math.round(netAfterCosts * 100) / 100,
          topWin: wins[0]
            ? {
                symbol: wins[0].symbol,
                pnl: wins[0].pnlInr,
                setup: wins[0].setupType,
              }
            : null,
        },
      })
      .onConflictDoUpdate({
        target: performanceStatsTable.date,
        set: {
          totalSuggestions: total,
          wins: wins.length,
          losses: losses.length,
          expired: expired.length,
          winRate: winRate.toFixed(2),
          profitFactor: Math.min(profitFactor, 999).toFixed(2),
          avgRrRealized: avgRr.toFixed(2),
          totalPnlInr: totalPnl.toFixed(2),
        },
      });

    // Save market metrics for today
    const mktState = getMarketState();
    if (mktState.niftyPrice != null) {
      const strongestSector =
        [...mktState.topSectors].sort((a, b) => b.changePct - a.changePct)[0]
          ?.name ?? null;
      const weakestSector =
        [...mktState.topSectors].sort((a, b) => a.changePct - b.changePct)[0]
          ?.name ?? null;

      await db
        .insert(marketMetricsTable)
        .values({
          date: todayIST,
          niftyClose: mktState.niftyPrice.toFixed(2),
          niftyChangePct: mktState.niftyChangePct?.toFixed(2) ?? null,
          indiaVixClose: mktState.indiaVix?.toFixed(2) ?? null,
          advanceCount: mktState.advanceCount,
          declineCount: mktState.declineCount,
          regime: mktState.regime,
          strongestSector,
          weakestSector,
        })
        .onConflictDoUpdate({
          target: marketMetricsTable.date,
          set: {
            niftyClose: mktState.niftyPrice.toFixed(2),
            niftyChangePct: mktState.niftyChangePct?.toFixed(2) ?? null,
            indiaVixClose: mktState.indiaVix?.toFixed(2) ?? null,
            advanceCount: mktState.advanceCount,
            declineCount: mktState.declineCount,
            regime: mktState.regime,
            strongestSector,
            weakestSector,
          },
        });
    }

    // Archive ticks for backtesting
    await archiveDailyTicks();

    // Broadcast day summary
    const pnlSign = totalPnl >= 0 ? "+" : "";
    broadcast({
      event: "system_alert",
      data: {
        message: `Day closed — ${total} signals: ${wins.length}W / ${losses.length}L / ${expired.length} expired. Net P&L: ${pnlSign}₹${Math.round(totalPnl)}. Win rate: ${winRate.toFixed(0)}%.`,
      },
    });

    logger.info(
      {
        date: todayIST,
        total,
        wins: wins.length,
        losses: losses.length,
        totalPnl,
      },
      "Post-market analysis saved",
    );
  } catch (err) {
    logger.error({ err }, "Post-market analysis failed");
  }
}

function computeSetupBreakdown(
  rows: (typeof suggestionsTable.$inferSelect)[],
): Record<string, { wins: number; losses: number }> {
  const breakdown: Record<string, { wins: number; losses: number }> = {};
  for (const r of rows) {
    if (!breakdown[r.setupType])
      breakdown[r.setupType] = { wins: 0, losses: 0 };
    if (r.status === "TARGET_1_HIT" || r.status === "TARGET_2_HIT") {
      breakdown[r.setupType]!.wins++;
    } else if (r.status === "STOP_HIT") {
      breakdown[r.setupType]!.losses++;
    }
  }
  return breakdown;
}
