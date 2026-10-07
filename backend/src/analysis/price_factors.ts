import type { OHLCV } from "./types";
import { fastEMA } from "./indicators/ema";
import { computeRSI } from "./indicators/rsi";
import { computeATR } from "./indicators/atr";
import { fastADX } from "./indicators/adx";
import { computeVolumeRatio } from "./indicators/volume";
import { computeBollingerBands } from "./indicators/bollinger_bands";

/** Only call with validated completed candles. Guard indicator neutral defaults. */
export function derivePriceFactors(candles: OHLCV[]): Record<string, { value: number | null; unit: string }> {
  const closes = candles.map(c => c.close);
  const close = closes.at(-1);
  const result: Record<string, { value: number | null; unit: string }> = {};
  const add = (key: string, value: number | null | undefined, unit: string) => {
    result[key] = { value: typeof value === "number" && Number.isFinite(value) ? value : null, unit };
  };
  for (const span of [20, 50, 200]) {
    add(`ema${span}Dist`, close && candles.length >= span ? 100 * (close / fastEMA(closes, span) - 1) : null, "percent");
  }
  add("rsi14", candles.length >= 15 ? computeRSI(closes) : null, "index");
  add("atrPct", close && candles.length >= 15 ? 100 * computeATR(candles) / close : null, "percent");
  add("adx14", candles.length >= 29 ? fastADX(candles) : null, "index");
  add("volumeRatio", candles.length >= 21 ? computeVolumeRatio(candles.map(c => c.volume)) : null, "ratio");
  add("bbWidthPct", candles.length >= 20 ? 100 * computeBollingerBands(closes).at(-1)!.bandwidth : null, "percent");
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const volatility = (values: number[]) => {
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
  };
  for (const span of [20, 60, 126]) {
    add(`realizedVol${span}`, returns.length >= span ? 100 * Math.sqrt(252) * volatility(returns.slice(-span)) : null, "annualized_percent");
  }
  for (const span of [126, 252]) {
    add(`return_${span}d`, close && closes.length > span ? 100 * (close / closes[closes.length - span - 1]! - 1) : null, "percent");
  }
  return result;
}
