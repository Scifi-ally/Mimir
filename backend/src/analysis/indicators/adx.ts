import { OHLCV } from "../technical";



// ── ADX (proper Wilder's smoothing) ──────────────────────────────────────────
export function fastADX(candles: OHLCV[], period = 14): number {
  if (candles.length < period * 2 + 1) return 20;
  let sTR = 0, sPlusDM = 0, sMinusDM = 0;
  
  for (let i = 1; i <= period; i++) {
    const upMove = candles[i]!.high - candles[i - 1]!.high;
    const downMove = candles[i - 1]!.low - candles[i]!.low;
    sPlusDM += (upMove > downMove && upMove > 0 ? upMove : 0);
    sMinusDM += (downMove > upMove && downMove > 0 ? downMove : 0);
    sTR += Math.max(
      candles[i]!.high - candles[i]!.low,
      Math.abs(candles[i]!.high - candles[i - 1]!.close),
      Math.abs(candles[i]!.low - candles[i - 1]!.close)
    );
  }

  let adx = 0;
  let adxCount = 0;

  for (let i = period + 1; i < candles.length; i++) {
    const upMove = candles[i]!.high - candles[i - 1]!.high;
    const downMove = candles[i - 1]!.low - candles[i]!.low;
    const pDM = (upMove > downMove && upMove > 0 ? upMove : 0);
    const mDM = (downMove > upMove && downMove > 0 ? downMove : 0);
    const tr = Math.max(
      candles[i]!.high - candles[i]!.low,
      Math.abs(candles[i]!.high - candles[i - 1]!.close),
      Math.abs(candles[i]!.low - candles[i - 1]!.close)
    );

    sTR = sTR - sTR / period + tr;
    sPlusDM = sPlusDM - sPlusDM / period + pDM;
    sMinusDM = sMinusDM - sMinusDM / period + mDM;

    const plusDI = sTR > 0 ? (sPlusDM / sTR) * 100 : 0;
    const minusDI = sTR > 0 ? (sMinusDM / sTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    
    if (adxCount < period) {
      adx += dx;
      adxCount++;
      if (adxCount === period) adx /= period;
    } else {
      adx = (adx * (period - 1) + dx) / period;
    }
  }
  return Math.round(adx * 100) / 100;
}