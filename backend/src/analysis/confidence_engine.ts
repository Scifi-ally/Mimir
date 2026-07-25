import { desc, inArray } from "drizzle-orm";
import { db } from "../../db/src";
import { suggestionsTable } from "../../db/src";

// EXPIRED here means a FILLED trade that timed out — never-filled PENDING rows
// are closed as MISSED (see accuracy_tracker) and deliberately excluded so
// forced end-of-day expiries of untouched entries can't trip the auto-pause.
const CLOSED_STATUSES = ["TARGET_1_HIT", "TARGET_2_HIT", "STOP_HIT", "EXPIRED"] as const;

export async function evaluateAutomationHealth(lookbackTrades = 40): Promise<{
  shouldPause: boolean;
  winRate: number;
  avgPnl: number;
  trades: number;
  reason: string | null;
}> {
  const rows = await db
    .select({
      status: suggestionsTable.status,
      pnlInr: suggestionsTable.pnlInr,
    })
    .from(suggestionsTable)
    .where(inArray(suggestionsTable.status, [...CLOSED_STATUSES]))
    .orderBy(desc(suggestionsTable.generatedAt))
    .limit(lookbackTrades);

  const trades = rows.length;

  // winRate over DECIDED trades only (target hits vs stop hits). EXPIRED rows
  // are filled scratch trades force-closed at the session sweep with ~0 PnL —
  // counting them as non-wins made routine end-of-day expiries look like a
  // performance collapse and tripped the auto-pause on healthy days.
  const wins = rows.filter(
    (r) => r.status === "TARGET_1_HIT" || r.status === "TARGET_2_HIT",
  ).length;
  const losses = rows.filter((r) => r.status === "STOP_HIT").length;
  const decided = wins + losses;
  if (decided < 12) {
    return { shouldPause: false, winRate: 0, avgPnl: 0, trades, reason: null };
  }

  const winRate = (wins / decided) * 100;
  const avgPnl = rows.reduce((a, r) => a + (r.pnlInr ? parseFloat(r.pnlInr) : 0), 0) / trades;

  if (winRate < 40 && avgPnl < 0) {
    return {
      shouldPause: true,
      winRate: Math.round(winRate * 100) / 100,
      avgPnl: Math.round(avgPnl * 100) / 100,
      trades,
      reason: "recent performance degraded",
    };
  }

  return {
    shouldPause: false,
    winRate: Math.round(winRate * 100) / 100,
    avgPnl: Math.round(avgPnl * 100) / 100,
    trades,
    reason: null,
  };
}
