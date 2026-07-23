import { db, suggestionsTable } from "../../db/src";
import { and, eq, gte, sql } from "drizzle-orm";
import { todayStartUTC } from "../lib/ist-time";
import { logger } from "../lib/logger";

export async function checkDbConnection(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch (err) {
    logger.error({ err }, "System status DB connectivity check failed");
    return false;
  }
}

export interface DailyStats {
  dailyLossToday: number;
  signalsGenerated: number;
  averageConfidence: number | null;
  averageRiskReward: number | null;
}

export async function getDailyStats(): Promise<DailyStats> {
  let dailyLossToday = 0;
  let signalsGenerated = 0;
  let averageConfidence: number | null = null;
  let averageRiskReward: number | null = null;

  try {
    const rows = await db
      .select({ totalLoss: sql<number>`SUM(CAST(${suggestionsTable.pnlInr} AS NUMERIC))` })
      .from(suggestionsTable)
      .where(
        and(
          gte(suggestionsTable.generatedAt, todayStartUTC()),
          eq(suggestionsTable.status, "STOP_HIT"),
        ),
      );

    dailyLossToday = rows[0]?.totalLoss ?? 0;

    const todaySuggestions = await db
      .select({ confidence: suggestionsTable.confidence, riskReward: suggestionsTable.riskReward })
      .from(suggestionsTable)
      .where(gte(suggestionsTable.generatedAt, todayStartUTC()));
      
    signalsGenerated = todaySuggestions.length;

    const confidenceValues = todaySuggestions
      .map((row) => row.confidence)
      .filter((value): value is number => value != null);

    averageConfidence = confidenceValues.length > 0
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : null;

    const riskRewardValues = todaySuggestions
      .map((row) => (row.riskReward != null ? Number(row.riskReward) : null))
      .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);

    averageRiskReward = riskRewardValues.length > 0
      ? riskRewardValues.reduce((sum, value) => sum + value, 0) / riskRewardValues.length
      : null;
      
  } catch (err) {
    logger.error({ err }, "Failed to get daily stats");
  }

  return { dailyLossToday, signalsGenerated, averageConfidence, averageRiskReward };
}

export async function getCalibrationReport(since: Date) {
  const rows = await db
    .select({
      setupType: suggestionsTable.setupType,
      direction: suggestionsTable.direction,
      trades: sql<number>`count(*)::int`,
      wins: sql<number>`count(*) filter (where ${suggestionsTable.status} in ('TARGET_1_HIT','TARGET_2_HIT'))::int`,
      losses: sql<number>`count(*) filter (where ${suggestionsTable.status} = 'STOP_HIT')::int`,
      expired: sql<number>`count(*) filter (where ${suggestionsTable.status} = 'EXPIRED')::int`,
      avgConfidence: sql<number>`round(avg(${suggestionsTable.confidence}))::int`,
      totalPnlInr: sql<number>`round(coalesce(sum(${suggestionsTable.pnlInr}), 0)::numeric, 2)::float`,
    })
    .from(suggestionsTable)
    .where(
      and(
        gte(suggestionsTable.generatedAt, since),
        sql`${suggestionsTable.status} in ('TARGET_1_HIT','TARGET_2_HIT','STOP_HIT','EXPIRED')`,
      ),
    )
    .groupBy(suggestionsTable.setupType, suggestionsTable.direction)
    .orderBy(sql`count(*) desc`);

  return rows.map((r) => {
    const decided = r.wins + r.losses;
    const realizedWinRate = decided > 0 ? Math.round((r.wins / decided) * 100) : null;
    return {
      ...r,
      realizedWinRate,
      calibrationGap:
        realizedWinRate != null && r.avgConfidence != null
          ? r.avgConfidence - realizedWinRate
          : null,
      expectancyPerTrade: decided > 0 ? Math.round((r.totalPnlInr / decided) * 100) / 100 : null,
    };
  });
}
