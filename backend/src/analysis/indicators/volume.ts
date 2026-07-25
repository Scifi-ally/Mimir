


// ── Volume ratio ──────────────────────────────────────────────────────────────

export function computeVolumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return 1;
  const avg = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  if (avg === 0) return 1;
  return Math.round((volumes[volumes.length - 1]! / avg) * 100) / 100;
}