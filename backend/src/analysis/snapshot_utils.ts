import { OHLCV, TechnicalSnapshot, fastEMA, computeRSI, fastATR, fastADX, computeVolumeRatio, fastRollingVWAP, fastSuperTrend, calculateVPVR, computeBollingerBands } from "./technical";



// ── Swing points (10 candles before today, excl. last 1) ─────────────────────

export function computeSwingPoints(candles: OHLCV[]): { swingLow: number; swingHigh: number } {
  const lookback = candles.slice(-11, -1);
  if (lookback.length === 0) return { swingLow: candles[candles.length - 1]!.low, swingHigh: candles[candles.length - 1]!.high };
  return {
    swingLow: Math.min(...lookback.map(c => c.low)),
    swingHigh: Math.max(...lookback.map(c => c.high)),
  };
}


// ── Snapshot ──────────────────────────────────────────────────────────────────

export function buildSnapshot(candles: OHLCV[]): TechnicalSnapshot | null {
  if (candles.length < 55) return null;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const last = candles.length - 1;
  const close = closes[last]!;

  // Use fast O(1) indicators
  const e9 = fastEMA(closes, 9);
  const e20 = fastEMA(closes, 20);
  const e50 = closes.length > 50 ? fastEMA(closes, 50) : close;
  const e200 = closes.length > 200 ? fastEMA(closes, 200) : close;

  const rsi14 = computeRSI(closes, 14); // computeRSI is already O(1) memory
  const atr14 = fastATR(candles.slice(-60), 14);
  const adx14 = fastADX(candles, 14);
  const volRatio = computeVolumeRatio(volumes);
  const vwap = fastRollingVWAP(candles);
  const superTrend = fastSuperTrend(candles, 10, 3);
  const vpvrPOC = calculateVPVR(candles.slice(-100));
  const bbArray = computeBollingerBands(closes, 20, 2);
  const bb = bbArray.length > 0 ? bbArray[bbArray.length - 1] : undefined;

  const high52w = Math.max(...highs.slice(-252));
  const low52w = Math.min(...lows.slice(-252));
  const distFromEma20Pct = ((close - e20) / e20) * 100;

  const { swingLow, swingHigh } = computeSwingPoints(candles);

  // Real 20-day average volume (excludes today)
  const avgDailyVolume = volumes.slice(-21, -1).length > 0
    ? Math.round(volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / volumes.slice(-21, -1).length)
    : 500_000;

  let trend: "UP" | "DOWN" | "SIDEWAYS" = "SIDEWAYS";
  if (close > e20 && e20 > e50 && e50 > e200) trend = "UP";
  else if (close < e20 && e20 < e50 && e50 < e200) trend = "DOWN";

  const volumeAnomaly = volRatio >= 3.0; // Volume is at least 300% of average

  return {
    close, ema9: e9, ema20: e20, ema50: e50, ema200: e200,
    rsi14, atr14, adx14, volumeRatio: volRatio,
    high52w, low52w, distFromEma20Pct, trend,
    avgDailyVolume, swingLow, swingHigh, vwap, superTrend, vpvrPOC,
    volumeAnomaly,
    bbUpper: bb?.upper, bbLower: bb?.lower, bbMiddle: bb?.middle, bbBandwidth: bb?.bandwidth,
  };
}


export function aggregateDailyToWeekly(dailyCandles: OHLCV[]): OHLCV[] {
  if (dailyCandles.length < 10) return [];
  const sorted = [...dailyCandles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const map = new Map<string, OHLCV[]>();
  for (const c of sorted) {
    // Shift into IST (+05:30) so getUTCDay() reflects the IST trading day,
    // not the UTC day (Monday IST candles are stamped Sunday 18:30 UTC).
    const d = new Date(new Date(c.timestamp).getTime() + 330 * 60 * 1000);
    const day = d.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + mondayOffset);
    d.setUTCHours(0, 0, 0, 0);
    const wk = d.toISOString().slice(0, 10);
    const arr = map.get(wk) ?? [];
    arr.push(c);
    map.set(wk, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, chunk]) => ({
      timestamp: chunk[chunk.length - 1]!.timestamp,
      open: chunk[0]!.open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1]!.close,
      volume: chunk.reduce((sum, c) => sum + c.volume, 0),
    }));
}