import { db } from "../../db/src";
import { institutionalFlowsTable } from "../../db/src/schema/institutional_flows";
import { desc } from "drizzle-orm";
import yahooFinance from "yahoo-finance2";
import { logger } from "../lib/logger";

export interface DivergenceResult {
  fiiNet5d: number;
  diiNet5d: number;
  totalFlow5d: number;
  niftyReturn5d: number;
  isDiverging: boolean;
  divergenceType: "BULLISH" | "BEARISH" | "NONE";
  penaltyOrBoost: number;
}

export async function computeFiiDiiDivergence(): Promise<DivergenceResult> {
  const defaultRes: DivergenceResult = {
    fiiNet5d: 0, diiNet5d: 0, totalFlow5d: 0, niftyReturn5d: 0,
    isDiverging: false, divergenceType: "NONE", penaltyOrBoost: 0
  };

  try {
    const flows = await db.select()
      .from(institutionalFlowsTable)
      .orderBy(desc(institutionalFlowsTable.date))
      .limit(5);

    if (flows.length < 5) return defaultRes;

    let fiiNet5d = 0;
    let diiNet5d = 0;
    for (const f of flows) {
      fiiNet5d += f.fiiNet;
      diiNet5d += f.diiNet;
    }
    const totalFlow5d = fiiNet5d + diiNet5d;

    const queryOptions = { period1: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], interval: "1d" as const };
    const result = await yahooFinance.historical("^NSEI", queryOptions);
    
    if (result.length < 5) return defaultRes;
    
    const recent = result.slice(-5);
    const oldestClose = recent[0].close;
    const newestClose = recent[recent.length - 1].close;
    
    const niftyReturn5d = ((newestClose - oldestClose) / oldestClose) * 100;

    let divergenceType: "BULLISH" | "BEARISH" | "NONE" = "NONE";
    let penaltyOrBoost = 0;

    if (niftyReturn5d < -1.0 && totalFlow5d > 2000) {
      divergenceType = "BULLISH";
      penaltyOrBoost = 10;
    } 
    else if (niftyReturn5d > 1.0 && totalFlow5d < -2000) {
      divergenceType = "BEARISH";
      penaltyOrBoost = -10;
    }

    return {
      fiiNet5d,
      diiNet5d,
      totalFlow5d,
      niftyReturn5d,
      isDiverging: divergenceType !== "NONE",
      divergenceType,
      penaltyOrBoost
    };
  } catch (err) {
    logger.error({ err }, "Failed to compute FII/DII divergence");
    return defaultRes;
  }
}

let cachedDivergence: DivergenceResult | null = null;

export async function getFiiDiiDivergence(): Promise<DivergenceResult> {
  if (cachedDivergence) return cachedDivergence;
  cachedDivergence = await computeFiiDiiDivergence();
  return cachedDivergence;
}

export function resetDivergenceCache() {
  cachedDivergence = null;
}
