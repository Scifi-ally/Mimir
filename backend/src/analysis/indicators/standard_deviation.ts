


// ── Standard Deviation ────────────────────────────────────────────────────────

export function computeStandardDeviation(values: number[], smas: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(0);
    } else {
      const sma = smas[i]!;
      const variance = values.slice(i - period + 1, i + 1).reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
      result.push(Math.sqrt(variance));
    }
  }
  return result;
}