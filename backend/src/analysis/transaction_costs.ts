/** Current standard Upstox NSE cash-delivery schedule, checked 2026-10-02.
 * https://upstox.com/brokerage-charges/
 * Conservative CURRENT-cost scenario for historical research, not a claim
 * that all historical years or negotiated accounts used these exact tariffs. */
export const DELIVERY_FEE_MODEL = "upstox-cash-delivery-2026-10";
export function cashDeliveryCosts(entry: number, exit: number, quantity: number): number {
  if (![entry, exit, quantity].every(v => Number.isFinite(v) && v > 0) || !Number.isInteger(quantity)) {
    throw new Error("Positive prices and an integer quantity are required for delivery costs");
  }
  const buy = entry * quantity, sell = exit * quantity, turnover = buy + sell;
  const brokerage = 40; // Standard delivery: INR20 per executed order.
  const exchange = turnover * .0000307;
  const sebi = turnover * .000001;
  const ipft = turnover * .000000001;
  const dp = 20;
  const gst = .18 * (brokerage + exchange + sebi + ipft + dp);
  const stt = turnover * .001;
  const stamp = buy * .00015;
  return brokerage + exchange + sebi + ipft + dp + gst + stt + stamp;
}

export function cashIntradayCosts(buyPrice: number, sellPrice: number, quantity: number): number {
  if (![buyPrice, sellPrice, quantity].every(v => Number.isFinite(v) && v > 0) || !Number.isInteger(quantity)) {
    throw new Error("Positive prices and integer shares required");
  }
  const buy = buyPrice * quantity, sell = sellPrice * quantity, turnover = buy + sell;
  const brokerage = Math.min(20, buy * .001) + Math.min(20, sell * .001);
  const exchange = turnover * .0000307, sebi = turnover * .000001, ipft = turnover * .000000001;
  return brokerage + exchange + sebi + ipft + .18 * (brokerage + exchange + sebi + ipft)
    + sell * .00025 + buy * .00003;
}

export function isDeliveryTrade(tradeType: string | null | undefined, setupType = ""): boolean {
  if (tradeType) return ["SWING", "POSITIONAL", "DELIVERY", "CNC"].includes(tradeType.toUpperCase());
  return /swing|cnc|delivery/i.test(setupType);
}
