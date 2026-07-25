import { MACDResult, computeEMA } from "../technical";



export function computeMACD(closes: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): MACDResult[] {
  const fastEma = computeEMA(closes, fastPeriod);
  const slowEma = computeEMA(closes, slowPeriod);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(fastEma[i]! - slowEma[i]!);
  }
  const signalLine = computeEMA(macdLine, signalPeriod);
  const result: MACDResult[] = [];
  for (let i = 0; i < closes.length; i++) {
    result.push({
      macd: macdLine[i]!,
      signal: signalLine[i]!,
      histogram: macdLine[i]! - signalLine[i]!,
    });
  }
  return result;
}