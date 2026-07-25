import { OHLCV } from "../technical";



// ── ATR (Wilder's smoothing) ──────────────────────────────────────────────────

export function computeATR(candles: OHLCV[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    const pc = candles[i - 1]!.close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const seedPeriod = Math.min(period, trs.length);
  let atr = trs.slice(0, seedPeriod).reduce((a, b) => a + b, 0) / seedPeriod;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return atr;
}


export function fastATR(candles: OHLCV[], period = 14): number {
  if (candles.length < 2) return 0;
  let atr = 0;
  const seedPeriod = Math.min(period, candles.length - 1);
  for (let i = 1; i <= seedPeriod; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    const pc = candles[i - 1]!.close;
    atr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  atr /= seedPeriod;
  for (let i = seedPeriod + 1; i < candles.length; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    const pc = candles[i - 1]!.close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}