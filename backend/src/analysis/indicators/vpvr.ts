import { OHLCV } from "../technical";



// ── VPVR POC ─────────────────────────────────────────────────────────────────

export function calculateVPVR(candles: OHLCV[], buckets = 12): number {
  if (candles.length === 0) return 0;
  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (const c of candles) {
    if (c.low < minLow) minLow = c.low;
    if (c.high > maxHigh) maxHigh = c.high;
  }
  
  if (minLow === Infinity || maxHigh === -Infinity || maxHigh === minLow) {
    return candles[candles.length - 1]!.close;
  }

  const bucketSize = (maxHigh - minLow) / buckets;
  const volumeProfile = new Array(buckets).fill(0);

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    let bucketIdx = Math.floor((typicalPrice - minLow) / bucketSize);
    if (bucketIdx >= buckets) bucketIdx = buckets - 1;
    if (bucketIdx < 0) bucketIdx = 0;
    volumeProfile[bucketIdx] += c.volume;
  }

  let maxVol = -1;
  let pocIdx = 0;
  for (let i = 0; i < buckets; i++) {
    if (volumeProfile[i]! > maxVol) {
      maxVol = volumeProfile[i]!;
      pocIdx = i;
    }
  }

  return minLow + (pocIdx + 0.5) * bucketSize;
}