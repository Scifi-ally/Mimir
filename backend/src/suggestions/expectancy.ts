/**
 * Expectancy Report
 * ─────────────────────────────────────────────────────────────────────────────
 * The single number that decides whether the system should trade at all:
 * expectancy per trade in R (risk units) after costs, computed from realized
 * suggestion outcomes. pnlInr already includes transaction costs (see
 * accuracy_tracker.netPnl), so no further cost adjustment happens here.
 *
 * R multiple = pnlInr / riskInr, where riskInr = maxRiskInr when recorded,
 * else |entry − stop| × qty. Trades with unresolvable risk are excluded and
 * counted separately so silent data quality problems stay visible.
 */
import { db, suggestionsTable } from "../../db/src";
import { and, gte, inArray } from "drizzle-orm";

const CLOSED_STATUSES = ["TARGET_1_HIT", "TARGET_2_HIT", "STOP_HIT", "EXPIRED"] as const;

export interface BucketStats {
  trades: number;
  wins: number;
  losses: number;
  scratches: number; // closed with |R| < 0.05 (expired near entry)
  winRatePct: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  expectancyR: number | null;
  totalPnlInr: number;
  profitFactor: number | null;
}

export interface ExpectancyReport {
  windowDays: number;
  from: string;
  totalClosed: number;
  excludedNoRisk: number;
  excludedNoPnl: number;
  overall: BucketStats;
  bySetup: Record<string, BucketStats>;
  byRegime: Record<string, BucketStats>;
  byDirection: Record<string, BucketStats>;
  verdict: string;
}

interface TradeR {
  r: number;
  pnlInr: number;
  setupType: string;
  regime: string;
  direction: string;
}

function emptyBucket(): BucketStats {
  return {
    trades: 0, wins: 0, losses: 0, scratches: 0,
    winRatePct: null, avgWinR: null, avgLossR: null,
    expectancyR: null, totalPnlInr: 0, profitFactor: null,
  };
}

function computeBucket(trades: TradeR[]): BucketStats {
  const b = emptyBucket();
  if (!trades.length) return b;

  let winSumR = 0;
  let lossSumR = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  for (const t of trades) {
    b.trades++;
    b.totalPnlInr += t.pnlInr;
    if (Math.abs(t.r) < 0.05) {
      b.scratches++;
    } else if (t.r > 0) {
      b.wins++;
      winSumR += t.r;
    } else {
      b.losses++;
      lossSumR += t.r;
    }
    if (t.pnlInr > 0) grossProfit += t.pnlInr;
    else grossLoss += Math.abs(t.pnlInr);
  }

  const decided = b.wins + b.losses;
  b.winRatePct = decided > 0 ? Math.round((b.wins / decided) * 1000) / 10 : null;
  b.avgWinR = b.wins > 0 ? Math.round((winSumR / b.wins) * 100) / 100 : null;
  b.avgLossR = b.losses > 0 ? Math.round((lossSumR / b.losses) * 100) / 100 : null;
  b.expectancyR = Math.round((trades.reduce((s, t) => s + t.r, 0) / trades.length) * 1000) / 1000;
  b.totalPnlInr = Math.round(b.totalPnlInr * 100) / 100;
  b.profitFactor = grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : null;
  return b;
}

function verdictFor(overall: BucketStats): string {
  if (overall.trades < 30) {
    return `INSUFFICIENT DATA (${overall.trades} closed trades — need 30+, ideally 100+, before trusting any expectancy number)`;
  }
  if (overall.expectancyR == null) return "INSUFFICIENT DATA";
  if (overall.expectancyR >= 0.15) {
    return `POSITIVE EDGE (+${overall.expectancyR}R/trade after costs over ${overall.trades} trades). Keep filters as-is; consider gradual size-up only after 100+ trades.`;
  }
  if (overall.expectancyR > 0) {
    return `MARGINAL (+${overall.expectancyR}R/trade). Edge is thin — tighten filters (check bySetup for negative cells to disable) before adding size.`;
  }
  return `NEGATIVE (${overall.expectancyR}R/trade). Do NOT trade this live. Disable the worst setups in bySetup/byRegime and re-measure on paper.`;
}

export async function buildExpectancyReport(windowDays = 60): Promise<ExpectancyReport> {
  const from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select()
    .from(suggestionsTable)
    .where(
      and(
        inArray(suggestionsTable.status, [...CLOSED_STATUSES]),
        gte(suggestionsTable.generatedAt, from),
      ),
    );

  let excludedNoRisk = 0;
  let excludedNoPnl = 0;
  const trades: TradeR[] = [];

  for (const row of rows) {
    const pnl = row.pnlInr != null ? Number(row.pnlInr) : null;
    if (pnl == null || !Number.isFinite(pnl)) {
      excludedNoPnl++;
      continue;
    }
    let riskInr = row.maxRiskInr != null ? Number(row.maxRiskInr) : NaN;
    if (!Number.isFinite(riskInr) || riskInr <= 0) {
      const entry = Number(row.entryPrice);
      const stop = Number(row.stopLoss);
      riskInr = Math.abs(entry - stop) * row.quantity;
    }
    if (!Number.isFinite(riskInr) || riskInr <= 0) {
      excludedNoRisk++;
      continue;
    }
    trades.push({
      r: pnl / riskInr,
      pnlInr: pnl,
      setupType: row.setupType || "UNKNOWN",
      regime: row.marketRegime || "UNKNOWN",
      direction: row.direction || "UNKNOWN",
    });
  }

  const groupBy = (key: (t: TradeR) => string): Record<string, BucketStats> => {
    const groups = new Map<string, TradeR[]>();
    for (const t of trades) {
      const k = key(t);
      const arr = groups.get(k) ?? [];
      arr.push(t);
      groups.set(k, arr);
    }
    const out: Record<string, BucketStats> = {};
    for (const [k, arr] of groups) out[k] = computeBucket(arr);
    return out;
  };

  const overall = computeBucket(trades);
  return {
    windowDays,
    from: from.toISOString(),
    totalClosed: rows.length,
    excludedNoRisk,
    excludedNoPnl,
    overall,
    bySetup: groupBy((t) => t.setupType),
    byRegime: groupBy((t) => t.regime),
    byDirection: groupBy((t) => t.direction),
    verdict: verdictFor(overall),
  };
}
