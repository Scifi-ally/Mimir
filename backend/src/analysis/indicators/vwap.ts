import { OHLCV } from "../technical";

export function fastRollingVWAP(candles: OHLCV[]): number {
  if (candles.length === 0) return 0;
  let cumVol = 0;
  let cumTypVol = 0;
  
  const lastCandle = candles[candles.length - 1]!;
  const lastDayStr = new Date(lastCandle.timestamp).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });
  
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i]!;
    const dayStr = new Date(c.timestamp).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });
    if (dayStr !== lastDayStr) break;
    const typ = (c.high + c.low + c.close) / 3;
    cumVol += c.volume;
    cumTypVol += typ * c.volume;
  }
  return cumVol > 0 ? cumTypVol / cumVol : lastCandle.close;
}