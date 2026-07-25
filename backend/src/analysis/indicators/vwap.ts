import { OHLCV } from "../technical";



// ── VWAP (Rolling 20-period) ─────────────────────────────────────────────────

// eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
export function computeRollingVWAP(candles: OHLCV[], _period = 20): number[] {
  const result: number[] = [];
  let cumVol = 0;
  let cumTypVol = 0;
  let currentDay = "";

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const d = new Date(c.timestamp);
    // Convert to IST date string for day detection
    const dayStr = d.toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });

    // Reset VWAP at start of new trading session
    if (dayStr !== currentDay) {
      currentDay = dayStr;
      cumVol = 0;
      cumTypVol = 0;
    }

    const typ = (c.high + c.low + c.close) / 3;
    cumVol += c.volume;
    cumTypVol += typ * c.volume;
    result.push(cumVol > 0 ? cumTypVol / cumVol : c.close);
  }
  return result;
}


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