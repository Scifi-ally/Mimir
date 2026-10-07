/** Suggestion outcomes are diagnostics, not broker-verified realized profits. */
export function summarizeOutcomeEvidence(values: Array<number | null>, minSamples = 30) {
  const measured = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (measured.length < minSamples) return { samples: measured.length, winRatePct: null, meanPnl: null, lowerMean95: null };
  const mean = measured.reduce((s, v) => s + v, 0) / measured.length;
  const variance = measured.reduce((s, v) => s + (v - mean) ** 2, 0) / (measured.length - 1);
  return { samples: measured.length, winRatePct: 100 * measured.filter(v => v > 0).length / measured.length,
    meanPnl: mean, lowerMean95: mean - 1.96 * Math.sqrt(variance / measured.length) };
}

export function diagnosticPnl(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
