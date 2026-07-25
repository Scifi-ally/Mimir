import { db } from "../../db/src";
import { paperPositionsTable } from "../../db/src/schema/paper_trading";
import { desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export interface ModelDecayTelemetry {
  realizedHitRate: number;
  realizedSharpe: number;
  referenceSharpeLow: number;
  isFlagged: boolean;
  sampleSize: number;
}

export class TelemetryEngine {
  private readonly WINDOW_SIZE = 100;
  private readonly MIN_SAMPLE_SIZE = 30;
  // Lower bound derived from the out-of-fold reference distribution of Phase 5.
  private readonly REFERENCE_SHARPE_LOW = 0.20; 

  private consecutiveFlaggedCount = 0;

  async computeDecayTelemetry(): Promise<ModelDecayTelemetry | null> {
    try {
      const recentTrades = await db
        .select({
          realizedPnl: paperPositionsTable.realizedPnl,
        })
        .from(paperPositionsTable)
        .where(eq(paperPositionsTable.status, "CLOSED"))
        .orderBy(desc(paperPositionsTable.closedAt))
        .limit(this.WINDOW_SIZE);

      if (recentTrades.length === 0) {
        return null;
      }

      let wins = 0;
      let sumPnl = 0;
      const pnlArr: number[] = [];

      for (const trade of recentTrades) {
        const pnl = Number(trade.realizedPnl);
        pnlArr.push(pnl);
        sumPnl += pnl;
        if (pnl > 0) wins++;
      }

      const sampleSize = pnlArr.length;
      const mean = sumPnl / sampleSize;
      const variance = pnlArr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / sampleSize;
      const stdDev = Math.sqrt(variance);

      const realizedSharpe = stdDev > 1e-6 ? mean / stdDev : 0;
      const realizedHitRate = wins / sampleSize;
      
      const belowBound = realizedSharpe < this.REFERENCE_SHARPE_LOW && sampleSize >= this.MIN_SAMPLE_SIZE;
      
      if (belowBound) {
        this.consecutiveFlaggedCount++;
      } else {
        this.consecutiveFlaggedCount = 0;
      }
      
      // Flag if below lower bound for 2+ consecutive checks
      const isFlagged = this.consecutiveFlaggedCount >= 2;

      return {
        realizedHitRate,
        realizedSharpe,
        referenceSharpeLow: this.REFERENCE_SHARPE_LOW,
        isFlagged,
        sampleSize,
      };
    } catch (error) {
      logger.error({ err: error }, "Failed to compute decay telemetry");
      return null;
    }
  }
}
