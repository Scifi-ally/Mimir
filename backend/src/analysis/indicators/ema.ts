


// ── EMA ──────────────────────────────────────────────────────────────────────

export function computeEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / Math.min(period, values.length);
  let prev = seed;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(values[i]!);
    } else if (i === period - 1) {
      result.push(seed);
      prev = seed;
    } else {
      prev = values[i]! * k + prev * (1 - k);
      result.push(prev);
    }
  }
  return result;
}


export function fastEMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  const seedPeriod = Math.min(period, values.length);
  let ema = 0;
  for (let i = 0; i < seedPeriod; i++) {
    ema += values[i]!;
  }
  ema /= seedPeriod;
  for (let i = seedPeriod; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
  }
  return ema;
}