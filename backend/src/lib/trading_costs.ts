export const DELIVERY_COST_RATE_PER_SIDE = 0.0015;
export const INTRADAY_COST_RATE_PER_SIDE = 0.0005;

export function resolveCostPerSide(
  args: string[] = process.argv,
  fallback = DELIVERY_COST_RATE_PER_SIDE,
): number {
  const index = args.indexOf("--costPerSide");
  const value = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export interface PaperTradeCharges {
  brokerage: number;
  stt: number;
  exchangeTransaction: number;
  sebi: number;
  gst: number;
  stampDuty: number;
}

export function calculateIntradayCharges(
  buyValue: number,
  sellValue: number,
  brokeragePerOrder: number,
): PaperTradeCharges {
  const exchangeTransaction = (buyValue + sellValue) * 0.0000325;
  const sebi = (buyValue + sellValue) * 0.000001;
  const brokerage = brokeragePerOrder * 2;
  const stt = sellValue * 0.00025;
  const stampDuty = buyValue * 0.00003;
  const gst = (brokerage + exchangeTransaction + sebi) * 0.18;
  return { brokerage, stt, exchangeTransaction, sebi, gst, stampDuty };
}

export function totalCharges(charges: PaperTradeCharges): number {
  return charges.brokerage
    + charges.stt
    + charges.exchangeTransaction
    + charges.sebi
    + charges.gst
    + charges.stampDuty;
}
