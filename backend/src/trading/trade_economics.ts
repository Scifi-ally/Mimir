import { getConfig } from "../config";

export type TradeDirection = "BUY" | "SELL";
export type TradeType = "INTRADAY" | "SWING";

export interface SizingResult {
  quantity: number;
  riskAmountInr: number;
  actualRiskInr: number;
  riskPct: number;
  investmentAmount: number;
  rejected: boolean;
  rejectionReason?: "risk_budget_too_small" | "invalid_prices" | "invalid_capital";
}

/**
 * Size a position without ever overriding the risk budget to force one unit.
 * A trade that cannot purchase one whole unit within its risk budget is
 * rejected instead of silently exceeding the configured maximum loss.
 */
export function computeSafeQuantity(params: {
  capital: number;
  riskPct: number;
  entryPrice: number;
  stopLoss: number;
  direction: TradeDirection;
  maxPositionValuePct?: number;
}): SizingResult {
  const { capital, riskPct, entryPrice, stopLoss, direction } = params;
  const maxPositionValuePct = params.maxPositionValuePct ?? 0.20;
  const riskPerShare = direction === "BUY"
    ? entryPrice - stopLoss
    : stopLoss - entryPrice;

  if (!(capital > 0) || !(entryPrice > 0) || !(riskPct > 0)) {
    return { quantity: 0, riskAmountInr: 0, actualRiskInr: 0, riskPct: 0, investmentAmount: 0, rejected: true, rejectionReason: "invalid_capital" };
  }
  if (!(riskPerShare > 0) || !Number.isFinite(riskPerShare)) {
    return { quantity: 0, riskAmountInr: 0, actualRiskInr: 0, riskPct: 0, investmentAmount: 0, rejected: true, rejectionReason: "invalid_prices" };
  }

  const riskAmountInr = capital * (riskPct / 100);
  const maxPositionValue = capital * maxPositionValuePct;
  const quantityByRisk = Math.floor(riskAmountInr / riskPerShare);
  const quantityByValue = Math.floor(maxPositionValue / entryPrice);
  const quantity = Math.min(quantityByRisk, quantityByValue);

  if (quantity < 1) {
    return { quantity: 0, riskAmountInr, actualRiskInr: 0, riskPct: 0, investmentAmount: 0, rejected: true, rejectionReason: "risk_budget_too_small" };
  }

  const actualRiskInr = quantity * riskPerShare;
  const investmentAmount = quantity * entryPrice;
  return {
    quantity,
    riskAmountInr,
    actualRiskInr,
    riskPct: capital > 0 ? (actualRiskInr / capital) * 100 : 0,
    investmentAmount,
    rejected: false,
  };
}

/**
 * Calculate the common transaction-cost model used by both outcome labeling and
 * paper execution. Slippage is represented by the actual entry/exit prices;
 * this function accounts for the explicit broker and sell-side STT charges.
 */
export function calculateNetPnl(params: {
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  direction: TradeDirection;
  tradeType?: TradeType;
  grossPnl?: number;
  brokeragePerOrderInr?: number;
  sttRate?: number;
}): { grossPnl: number; brokerage: number; stt: number; totalCharges: number; netPnl: number } {
  const { entryPrice, exitPrice, quantity, direction } = params;
  const grossPnl = params.grossPnl ?? (direction === "BUY"
    ? (exitPrice - entryPrice) * quantity
    : (entryPrice - exitPrice) * quantity);
  const brokeragePerOrder = params.brokeragePerOrderInr ?? getConfig().brokeragePerOrderInr;
  const sttRate = params.sttRate ?? 0.00025;
  // For an intraday short, the opening sell is the STT leg; for a long, the
  // closing sell is the STT leg. This matches the paper-engine convention.
  const sellValue = direction === "BUY" ? exitPrice * quantity : entryPrice * quantity;
  const brokerage = Math.max(0, brokeragePerOrder) * 2;
  const stt = Math.max(0, sellValue) * sttRate;
  const totalCharges = brokerage + stt;
  return { grossPnl, brokerage, stt, totalCharges, netPnl: grossPnl - totalCharges };
}
