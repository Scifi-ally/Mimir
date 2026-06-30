import { and, desc, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/src";
import { suggestionsTable } from "../../db/src";

export interface ConfidenceInput {
  setupType: string;
  marketRegime: string;
  direction: "BUY" | "SELL";
  baseScore: number;
  mtfConfluence: number;
  hourlyConfirmed: boolean;
}

export interface ConfidenceOutput {
  confidence: number; // 0-100
  shadowConfidence: number;
  expectedValue: number;
  historicalWinRate: number;
  sampleSize: number;
  notes: string[];
  modelVersion: string;
  shadowModelVersion: string;
}

const CLOSED_STATUSES = ["TARGET_1_HIT", "TARGET_2_HIT", "STOP_HIT", "EXPIRED"] as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export async function computeAdaptiveConfidence(
  input: ConfidenceInput,
  lookbackDays = 90,
): Promise<ConfidenceOutput> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      status: suggestionsTable.status,
      pnlInr: suggestionsTable.pnlInr,
      riskReward: suggestionsTable.riskReward,
    })
    .from(suggestionsTable)
    .where(
      and(
        gte(suggestionsTable.generatedAt, since),
        inArray(suggestionsTable.status, [...CLOSED_STATUSES]),
        sql`${suggestionsTable.setupType} = ${input.setupType}`,
        sql`coalesce(${suggestionsTable.marketRegime}, 'UNKNOWN') = ${input.marketRegime}`,
        sql`${suggestionsTable.direction} = ${input.direction}`,
      ),
    )
    .orderBy(desc(suggestionsTable.generatedAt))
    .limit(500);

  const sampleSize = rows.length;
  const wins = rows.filter(
    (r) => r.status === "TARGET_1_HIT" || r.status === "TARGET_2_HIT",
  ).length;
  const losses = rows.filter((r) => r.status === "STOP_HIT").length;
  const priorsWinRate = 0.52;
  const smoothK = 24;
  const rawWinRate = sampleSize > 0 ? wins / Math.max(wins + losses, 1) : priorsWinRate;
  const historicalWinRate =
    (rawWinRate * sampleSize + priorsWinRate * smoothK) / (sampleSize + smoothK);

  const totalPnl = rows.reduce((acc, r) => acc + (r.pnlInr ? parseFloat(r.pnlInr) : 0), 0);
  const expectedValue = sampleSize > 0 ? totalPnl / sampleSize : 0;

  const notes: string[] = [];
  if (sampleSize < 25) notes.push("low historical sample");
  if (input.hourlyConfirmed) notes.push("hourly confirmed");
  if (input.mtfConfluence >= 80) notes.push("strong MTF confluence");

  let confidence =
    input.baseScore * 7.2 +
    historicalWinRate * 34 +
    (input.mtfConfluence / 100) * 14 +
    (input.hourlyConfirmed ? 5 : -2);

  if (expectedValue < 0) confidence -= 7;
  if (sampleSize < 15) confidence -= 6;
  confidence = clamp(confidence, 0, 100);
  let shadowConfidence =
    input.baseScore * 6.6 +
    historicalWinRate * 30 +
    (input.mtfConfluence / 100) * 18 +
    (input.hourlyConfirmed ? 7 : -1);
  if (sampleSize < 20) shadowConfidence -= 4;
  shadowConfidence = clamp(shadowConfidence, 0, 100);

  return {
    confidence: Math.round(confidence * 100) / 100,
    shadowConfidence: Math.round(shadowConfidence * 100) / 100,
    expectedValue: Math.round(expectedValue * 100) / 100,
    historicalWinRate: Math.round(historicalWinRate * 10000) / 100,
    sampleSize,
    notes,
    modelVersion: "confidence_v1",
    shadowModelVersion: "confidence_shadow_v1",
  };
}

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
  if (trades < 12) {
    return { shouldPause: false, winRate: 0, avgPnl: 0, trades, reason: null };
  }

  const wins = rows.filter(
    (r) => r.status === "TARGET_1_HIT" || r.status === "TARGET_2_HIT",
  ).length;
  const winRate = (wins / trades) * 100;
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
