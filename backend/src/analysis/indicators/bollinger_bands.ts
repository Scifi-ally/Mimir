import { BollingerBands, computeSMA, computeStandardDeviation } from "../technical";



export function computeBollingerBands(closes: number[], period = 20, multiplier = 2): BollingerBands[] {
  const smas = computeSMA(closes, period);
  const stddevs = computeStandardDeviation(closes, smas, period);
  const result: BollingerBands[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push({ upper: closes[i]!, middle: closes[i]!, lower: closes[i]!, bandwidth: 0 });
    } else {
      const middle = smas[i]!;
      const stddev = stddevs[i]!;
      const upper = middle + multiplier * stddev;
      const lower = middle - multiplier * stddev;
      const bandwidth = middle > 0 ? (upper - lower) / middle : 0;
      result.push({ upper, middle, lower, bandwidth });
    }
  }
  return result;
}