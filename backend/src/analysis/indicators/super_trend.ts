import { OHLCV } from "../technical";



// ── SuperTrend (10, 3) ───────────────────────────────────────────────────────

export function computeSuperTrend(candles: OHLCV[], period = 10, multiplier = 3): number[] {
  if (candles.length < period) return candles.map(c => c.close);
  
  const atrs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      atrs.push(candles[i]!.high - candles[i]!.low);
    } else {
      const h = candles[i]!.high;
      const l = candles[i]!.low;
      const pc = candles[i-1]!.close;
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      if (i < period) {
        atrs.push((atrs[i-1]! * i + tr) / (i + 1));
      } else {
        atrs.push((atrs[i-1]! * (period - 1) + tr) / period);
      }
    }
  }

  const result: number[] = [];
  let isUpTrend = true;
  let finalUpper = 0;
  let finalLower = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const hl2 = (c.high + c.low) / 2;
    const atr = atrs[i]!;
    
    const basicUpper = hl2 + multiplier * atr;
    const basicLower = hl2 - multiplier * atr;

    if (i === 0) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      result.push(finalLower);
      continue;
    }

    const prevClose = candles[i-1]!.close;
    
    finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;

    if (c.close > finalUpper) isUpTrend = true;
    else if (c.close < finalLower) isUpTrend = false;
    
    result.push(isUpTrend ? finalLower : finalUpper);
  }
  
  return result;
}


export function fastSuperTrend(candles: OHLCV[], period = 10, multiplier = 3): number {
  if (candles.length <= period) return candles.length ? candles[candles.length - 1]!.close : 0;

  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    const pc = candles[i - 1]!.close;
    atr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  atr /= period;

  let isUpTrend = true;
  let finalUpper = 0;
  let finalLower = 0;

  for (let i = period; i < candles.length; i++) {
    const c = candles[i]!;
    const prevC = candles[i - 1]!;
    
    // Update ATR incrementally
    const h = c.high;
    const l = c.low;
    const pc = prevC.close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    atr = (atr * (period - 1) + tr) / period;

    const hl2 = (h + l) / 2;
    const basicUpper = hl2 + multiplier * atr;
    const basicLower = hl2 - multiplier * atr;

    if (i === period) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      continue;
    }

    finalUpper = basicUpper < finalUpper || pc > finalUpper ? basicUpper : finalUpper;
    finalLower = basicLower > finalLower || pc < finalLower ? basicLower : finalLower;

    if (c.close > finalUpper) isUpTrend = true;
    else if (c.close < finalLower) isUpTrend = false;
  }
  
  return isUpTrend ? finalLower : finalUpper;
}