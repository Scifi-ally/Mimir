/**
 * Risk Engine — Layer 6
 * ─────────────────────────────────────────────────────────────────────────────
 * Risk ALWAYS overrides AI. If risk criteria fail, the signal is rejected
 * regardless of how high the AI confidence is.
 *
 * Mandatory calculations:
 *   • Entry Price
 *   • Stop Loss
 *   • Target (T1, T2)
 *   • Position Size (Kelly-adjusted)
 *   • Risk Reward Ratio
 *
 * Rejection criteria:
 *   • RR < 1.5
 *   • Liquidity below threshold
 *   • Volatility exceeds limits (ATR% > 7.5 or < 0.6)
 *   • Daily loss limit exceeded
 *   • Max positions exceeded
 *   • Sector exposure exceeded
 */
import { getConfig } from "../config";
import { logger } from "../lib/logger";
import type { SetupCandidate, TechnicalSnapshot } from "./technical";
import type { FeatureVector } from "./feature_engine";
import { getGlobalMacroState } from "./global_macro";
import { getAutoTunedRiskParams } from "./learning_engine";
import { fetchFIIDIIData } from "../market_data/fii_dii";
import { fetchOptionChainData } from "../market_data/option_chain";

// ── Risk assessment output ───────────────────────────────────────────────────

export interface RiskAssessment {
  passed: boolean;
  rejectionReasons: string[];
  warningReasons: string[];

  // Position details
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;

  // Position sizing
  positionSize: number;       // Number of shares
  investmentAmount: number;   // Total investment in INR
  maxRiskInr: number;         // Max loss in INR if stop hit
  riskPercentage: number;     // Risk as % of capital
  stopDistancePct: number;    // Stop distance as % of entry

  // Checks
  liquidityOk: boolean;
  volatilityOk: boolean;
  sectorExposureOk: boolean;
  dailyLossLimitOk: boolean;
  positionLimitOk: boolean;
}

import { db } from "../../db/src";
import { suggestionsTable } from "../../db/src/schema/suggestions";
import { paperPositionsTable } from "../../db/src/schema/paper_trading";
import { and, gte, eq } from "drizzle-orm";
import { todayStartUTC } from "../lib/ist-time";
import { STOCK_SECTOR_MAP } from "./stock_scanner";

// ── Open position tracking (in-memory for fast checks) ───────────────────────

interface OpenPosition {
  symbol: string;
  sector: string;
  direction: "BUY" | "SELL";
  entryPrice: number;
  quantity: number;
  maxRiskInr: number;
}

let _openPositions: OpenPosition[] = [];
let _dailyPnlInr = 0;
let _dailyLossCount = 0;

export function updateOpenPositions(positions: OpenPosition[]): void {
  _openPositions = positions;
}

export function updateDailyPnl(pnl: number, lossCount: number): void {
  _dailyPnlInr = pnl;
  _dailyLossCount = lossCount;
}

export function resetDailyTracking(): void {
  _dailyPnlInr = 0;
  _dailyLossCount = 0;
}

export function getOpenPositionCount(): number {
  return _openPositions.length;
}

/**
 * Syncs the risk engine state with the database.
 * NOTE: This is called every minute via the scheduler. The 60s staleness window
 * is acceptable for the current trading cadence (suggestions generated every 5 mins).
 * No explicit locking is needed due to single-threaded Node.js event loop.
 */
export async function syncRiskEngineState(): Promise<void> {
  try {
    // We now use paperPositionsTable as the ground-truth for open positions.
    // If the paper engine rejects a trade, it never hits the portfolio.
    const activePositions = await db
      .select({
        symbol: paperPositionsTable.symbol,
        direction: paperPositionsTable.direction,
        entryPrice: paperPositionsTable.avgEntryPrice,
        quantity: paperPositionsTable.quantity,
        suggestionId: paperPositionsTable.suggestionId
      })
      .from(paperPositionsTable)
      .where(eq(paperPositionsTable.status, "OPEN"));

    // We still need maxRiskInr and setup from suggestionsTable for advanced limits
    const mapped: OpenPosition[] = [];
    for (const p of activePositions) {
      let maxRisk = 0;
      if (p.suggestionId) {
        const [sug] = await db.select().from(suggestionsTable).where(eq(suggestionsTable.id, p.suggestionId)).limit(1);
        if (sug && sug.maxRiskInr) {
          maxRisk = parseFloat(sug.maxRiskInr);
        }
      }
      mapped.push({
        symbol: p.symbol,
        sector: STOCK_SECTOR_MAP[p.symbol] ?? "Other",
        direction: p.direction as "BUY" | "SELL",
        entryPrice: parseFloat(p.entryPrice),
        quantity: p.quantity,
        maxRiskInr: maxRisk,
      });
    }

    updateOpenPositions(mapped);

    const todayStart = todayStartUTC();
    const closedToday = await db
      .select()
      .from(paperPositionsTable)
      .where(
        and(
          gte(paperPositionsTable.closedAt, todayStart),
          eq(paperPositionsTable.status, 'CLOSED')
        )
      );

    let pnl = 0;
    let lossCount = 0;
    for (const c of closedToday) {
      pnl += parseFloat(c.realizedPnl);
      if (parseFloat(c.realizedPnl) < 0) {
        lossCount++;
      }
    }

    updateDailyPnl(pnl, lossCount);
    logger.info(
      { activeCount: mapped.length, todayClosedCount: closedToday.length, pnl },
      "Risk engine state synced with database successfully"
    );
  } catch (err) {
    logger.error({ err }, "Failed to sync risk engine state with database");
  }
}

// ── Position sizing ──────────────────────────────────────────────────────────

/**
 * Fractional-Kelly risk fraction. Given a calibrated win probability `p` and a
 * reward:risk payoff `b` (target distance / stop distance, in R), the full Kelly
 * bet fraction is f* = (p·b − (1−p)) / b. We take a QUARTER of it — quarter-Kelly
 * is the standard conservative choice: it captures ~90% of full-Kelly's long-run
 * growth at a fraction of the variance and drawdown, and is robust to the
 * inevitable error in our probability estimate. Returns 0 when the edge is
 * non-positive (the model expects to lose → don't bet), so a negative-edge trade
 * is sized to zero even if it slips past the ranker gate.
 */
export function fractionalKellyRiskPct(
  winProbability: number,
  payoffRatio: number,
  maxRiskPct: number,
): number {
  if (!(payoffRatio > 0) || !(winProbability > 0) || !(winProbability < 1)) return maxRiskPct;
  const fullKelly = (winProbability * payoffRatio - (1 - winProbability)) / payoffRatio;
  if (fullKelly <= 0) return 0;
  const quarterKelly = fullKelly * 0.25;
  // Kelly is expressed as a fraction of capital to RISK. Convert to a percent and
  // cap at the configured per-trade max — Kelly may recommend more than we allow,
  // but never less-conservative than the hard ceiling.
  return Math.min(maxRiskPct, quarterKelly * 100);
}

function computePositionSize(
  capital: number,
  maxRiskPct: number,
  entryPrice: number,
  stopLoss: number,
  direction: "BUY" | "SELL",
  kelly?: { winProbability: number; payoffRatio: number },
): { quantity: number; maxRiskInr: number; investmentAmount: number; riskPct: number } {
  const riskPerShare = direction === "BUY"
    ? entryPrice - stopLoss
    : stopLoss - entryPrice;

  if (riskPerShare <= 0) {
    return { quantity: 0, maxRiskInr: 0, investmentAmount: 0, riskPct: 0 };
  }

  // Size the risk budget. With a calibrated win probability we scale it by
  // quarter-Kelly (edge-proportional); without one we use the flat configured
  // max (graceful degradation — identical to the previous behaviour).
  const effectiveRiskPct = kelly
    ? fractionalKellyRiskPct(kelly.winProbability, kelly.payoffRatio, maxRiskPct)
    : maxRiskPct;

  if (effectiveRiskPct <= 0) {
    return { quantity: 0, maxRiskInr: 0, investmentAmount: 0, riskPct: 0 };
  }

  const maxRiskInr = capital * (effectiveRiskPct / 100);
  let quantity = Math.floor(maxRiskInr / riskPerShare);

  // Cap position to 20% of capital
  const maxPositionValue = capital * 0.20;
  const positionValue = quantity * entryPrice;
  if (positionValue > maxPositionValue) {
    quantity = Math.floor(maxPositionValue / entryPrice);
  }

  if (quantity < 1) {
    return { quantity: 0, maxRiskInr: 0, investmentAmount: 0, riskPct: 0 };
  }

  const actualRiskInr = quantity * riskPerShare;
  const investmentAmount = quantity * entryPrice;
  const riskPct = capital > 0 ? (actualRiskInr / capital) * 100 : 0;

  return {
    quantity,
    maxRiskInr: Math.round(actualRiskInr * 100) / 100,
    investmentAmount: Math.round(investmentAmount * 100) / 100,
    riskPct: Math.round(riskPct * 100) / 100,
  };
}

// ── Core risk assessment ─────────────────────────────────────────────────────

export async function assessRisk(
  setup: SetupCandidate,
  snap: TechnicalSnapshot,
  sector: string,
  features?: FeatureVector,
  winProbability?: number | null,
): Promise<RiskAssessment> {
  const cfg = getConfig();
  const autoRisk = await getAutoTunedRiskParams();
  const rejections: string[] = [];
  const warnings: string[] = [];

  const { entryPrice, stopLoss, target1, target2, riskReward, direction } = setup;

  // ── Check 1: Risk-Reward ratio ────────────────────────────────────────
  const turnoverInr = snap.avgDailyVolume * snap.close;
  const liquidityOk =
    snap.avgDailyVolume >= cfg.minDailyVolume &&
    turnoverInr >= cfg.minDailyTurnoverInr;
  if (!liquidityOk) {
    if (snap.avgDailyVolume < cfg.minDailyVolume) {
      rejections.push(`Liquidity ${snap.avgDailyVolume.toLocaleString()} below minimum ${cfg.minDailyVolume.toLocaleString()}`);
    } else {
      rejections.push(`Turnover ₹${(turnoverInr / 1e7).toFixed(1)}cr below minimum ₹${(cfg.minDailyTurnoverInr / 1e7).toFixed(1)}cr`);
    }
  }

  // ── Check 2: RR ratio ─────────────────────────────────────────────────
  const effectiveMinRR = Math.max(cfg.minRiskReward, autoRisk.minRiskReward);
  if (riskReward < effectiveMinRR) {
    rejections.push(`Risk-reward ${riskReward.toFixed(2)} below auto-tuned minimum ${effectiveMinRR.toFixed(2)}`);
  }

  // ── Check 3: Volatility bounds ────────────────────────────────────────
  const atrPct = snap.close > 0 ? (snap.atr14 / snap.close) * 100 : 0;
  const volatilityOk = atrPct >= 0.6 && atrPct <= 7.5;
  if (!volatilityOk) {
    if (atrPct < 0.6) {
      rejections.push(`Volatility too low (ATR ${atrPct.toFixed(2)}%) — no tradeable movement`);
    } else {
      rejections.push(`Volatility too high (ATR ${atrPct.toFixed(2)}%) — excessive risk`);
    }
  }

  // ── Check 4: Stop distance sanity ─────────────────────────────────────
  const stopDistancePct = direction === "BUY"
    ? ((entryPrice - stopLoss) / entryPrice) * 100
    : ((stopLoss - entryPrice) / entryPrice) * 100;

  if (stopDistancePct > 8) {
    rejections.push(`Stop distance ${stopDistancePct.toFixed(1)}% too wide — max 8%`);
  }
  if (stopDistancePct < 0.3) {
    warnings.push(`Stop distance ${stopDistancePct.toFixed(2)}% very tight — may get whipsawed`);
  }

  // ── Check 5: Daily loss limit ─────────────────────────────────────────
  const dailyLossLimit = cfg.tradingCapital * (cfg.maxDailyLossPct / 100);
  const dailyLossLimitOk = _dailyPnlInr > -dailyLossLimit;
  if (!dailyLossLimitOk && _dailyPnlInr < 0) {
    rejections.push(`Daily loss limit reached: ₹${Math.abs(_dailyPnlInr).toFixed(0)} / ₹${dailyLossLimit.toFixed(0)}`);
  }

  // ── Check 6: Max open positions ───────────────────────────────────────
  const positionLimitOk = _openPositions.length < cfg.maxOpenPositions;
  if (!positionLimitOk) {
    rejections.push(`Max open positions reached (${_openPositions.length}/${cfg.maxOpenPositions})`);
  }

  // ── Check 7: Same-direction position limit ────────────────────────────
  const sameDirectionCount = _openPositions.filter(p => p.direction === direction).length;
  if (sameDirectionCount >= cfg.maxSameDirectionOpenPositions) {
    rejections.push(`Max same-direction positions reached (${sameDirectionCount}/${cfg.maxSameDirectionOpenPositions})`);
  }

  // ── Check 8: Sector exposure ──────────────────────────────────────────
  const sectorPositions = _openPositions.filter(p => p.sector === sector).length;
  const sectorExposureOk = sectorPositions < cfg.maxSectorExposure;
  if (!sectorExposureOk) {
    rejections.push(`Max sector exposure reached for ${sector} (${sectorPositions}/${cfg.maxSectorExposure})`);
  }

  // ── Check 9: Duplicate symbol ─────────────────────────────────────────
  const alreadyOpen = _openPositions.some(
    p => p.symbol === features?.symbol && p.direction === direction,
  );
  if (alreadyOpen) {
    rejections.push(`Already have an open ${direction} position in ${features?.symbol}`);
  }

  // ── Check 9: Indian Market Institutional Constraints ────────────────────
  const fiiDii = await fetchFIIDIIData();
  const optionChain = await fetchOptionChainData();

  if (fiiDii) {
    if (direction === "BUY" && fiiDii.fiiNetInr < -3000) {
      rejections.push(`Severe FII Selling (₹${fiiDii.fiiNetInr} Cr) — blocking BUY trades`);
    } else if (direction === "SELL" && fiiDii.fiiNetInr > 3000) {
      rejections.push(`Severe FII Buying (₹${fiiDii.fiiNetInr} Cr) — blocking SELL trades`);
    }
  }

  if (optionChain) {
    if (direction === "BUY" && optionChain.pcr < 0.6) {
      rejections.push(`Nifty PCR highly bearish (${optionChain.pcr}) — blocking BUY trades`);
    } else if (direction === "SELL" && optionChain.pcr > 1.4) {
      rejections.push(`Nifty PCR highly bullish (${optionChain.pcr}) — blocking SELL trades`);
    }
  }

  // ── Position Sizing Calculation ───────────────────────────────────────────────────
  const effectiveMaxRiskPct = Math.min(cfg.maxRiskPerTradePct, autoRisk.maxRiskPerTradePct);
  // Edge-proportional sizing: when the learned ranker gave a calibrated win
  // probability, size via quarter-Kelly on the setup's own payoff ratio. Without
  // one, fall back to the flat configured max (unchanged behaviour).
  const kelly =
    typeof winProbability === "number" && winProbability > 0 && riskReward > 0
      ? { winProbability, payoffRatio: riskReward }
      : undefined;
  let { quantity, maxRiskInr, investmentAmount, riskPct } = computePositionSize(
    cfg.tradingCapital,
    effectiveMaxRiskPct,
    entryPrice,
    stopLoss,
    direction,
    kelly,
  );

  // Dynamic Macro Risk Adjustment
  const macro = getGlobalMacroState();
  if (macro.eventRiskActive && quantity > 0) {
    warnings.push("Halving position size due to elevated global macro event risk (Yields/DXY)");
    quantity = Math.floor(quantity * 0.5);
    maxRiskInr = maxRiskInr * 0.5;
    investmentAmount = investmentAmount * 0.5;
    riskPct = riskPct * 0.5;
  }

  if (quantity === 0) {
    rejections.push("Position size computed to 0 — risk per share too large");
  }

  // ── Check: Aggregate deployed capital ────────────────────────────────
  const totalDeployed = _openPositions.reduce((sum, p) => sum + (p.entryPrice * p.quantity), 0);
  const maxDeployed = cfg.tradingCapital * ((cfg.maxDeployedCapitalPct ?? 90) / 100);
  if (totalDeployed + investmentAmount > maxDeployed) {
    const remainingCapital = Math.max(0, maxDeployed - totalDeployed);
    if (remainingCapital < entryPrice) {
      rejections.push(`Aggregate deployed capital would exceed ${cfg.maxDeployedCapitalPct ?? 90}% limit (₹${Math.round(totalDeployed)} deployed + ₹${Math.round(investmentAmount)} new > ₹${Math.round(maxDeployed)} max)`);
    } else {
      // Reduce position to fit within capital limit
      quantity = Math.floor(remainingCapital / entryPrice);
      investmentAmount = quantity * entryPrice;
      maxRiskInr = quantity * (direction === 'BUY' ? entryPrice - stopLoss : stopLoss - entryPrice);
      riskPct = cfg.tradingCapital > 0 ? (maxRiskInr / cfg.tradingCapital) * 100 : 0;
      warnings.push(`Position reduced to ${quantity} shares to stay within ${cfg.maxDeployedCapitalPct ?? 90}% deployed capital limit`);
    }
  }

  // ── Warnings (non-blocking) ───────────────────────────────────────────
  if (riskReward < 2.0 && riskReward >= 1.5) {
    warnings.push(`Risk-reward ${riskReward.toFixed(2)} — acceptable but not ideal (prefer >2.0)`);
  }
  if (snap.rsi14 > 75) {
    warnings.push(`RSI ${snap.rsi14.toFixed(0)} overbought — elevated reversal risk`);
  }
  if (snap.rsi14 < 25) {
    warnings.push(`RSI ${snap.rsi14.toFixed(0)} oversold — elevated bounce risk`);
  }
  if (_dailyLossCount >= 3) {
    warnings.push(`${_dailyLossCount} losses today — consider reducing position size`);
  }

  const passed = rejections.length === 0;

  if (!passed) {
    logger.debug(
      { symbol: features?.symbol, rejections, direction, rr: riskReward },
      "Risk assessment REJECTED",
    );
  }

  return {
    passed,
    rejectionReasons: rejections,
    warningReasons: warnings,
    entryPrice,
    stopLoss,
    target1,
    target2,
    riskReward,
    positionSize: quantity,
    investmentAmount,
    maxRiskInr,
    riskPercentage: riskPct,
    stopDistancePct: Math.round(stopDistancePct * 100) / 100,
    liquidityOk,
    volatilityOk,
    sectorExposureOk,
    dailyLossLimitOk,
    positionLimitOk,
  };
}
