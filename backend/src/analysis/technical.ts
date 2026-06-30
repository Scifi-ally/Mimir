export interface OHLCV {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalSnapshot {
  close: number;
  ema9: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi14: number;
  atr14: number;
  volumeRatio: number;
  adx14: number;
  high52w: number;
  low52w: number;
  distFromEma20Pct: number;
  trend: "UP" | "DOWN" | "SIDEWAYS";
  avgDailyVolume: number;
  swingLow: number;
  swingHigh: number;
  vwap: number;
  superTrend: number;
  vpvrPOC: number;
  volumeAnomaly: boolean;
}

export interface SetupCandidate {
  setupType: string;
  direction: "BUY" | "SELL";
  score: number;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  reasoning: string;
  confluence: string[];
}

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

// ── RSI (Wilder's smoothing over full history) ────────────────────────────────

export function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (ch > 0) avgGain += ch / period;
    else avgLoss += (-ch) / period;
  }
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

// ── ATR (Wilder's smoothing) ──────────────────────────────────────────────────

export function computeATR(candles: OHLCV[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    const pc = candles[i - 1]!.close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const seedPeriod = Math.min(period, trs.length);
  let atr = trs.slice(0, seedPeriod).reduce((a, b) => a + b, 0) / seedPeriod;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return atr;
}

// ── ADX (proper Wilder's smoothing) ──────────────────────────────────────────

export function computeADX(candles: OHLCV[], period = 14): number {
  if (candles.length < period * 2 + 1) return 20;
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i]!.high - candles[i - 1]!.high;
    const downMove = candles[i - 1]!.low - candles[i]!.low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      candles[i]!.high - candles[i]!.low,
      Math.abs(candles[i]!.high - candles[i - 1]!.close),
      Math.abs(candles[i]!.low - candles[i - 1]!.close),
    ));
  }
  let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let sMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dxValues: number[] = [];
  for (let i = period; i < trs.length; i++) {
    sTR = sTR - sTR / period + trs[i]!;
    sPlusDM = sPlusDM - sPlusDM / period + plusDMs[i]!;
    sMinusDM = sMinusDM - sMinusDM / period + minusDMs[i]!;
    const plusDI = sTR > 0 ? (sPlusDM / sTR) * 100 : 0;
    const minusDI = sTR > 0 ? (sMinusDM / sTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    dxValues.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
  }
  if (dxValues.length < period) return 20;
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]!) / period;
  }
  return Math.round(adx * 100) / 100;
}

// ── Volume ratio ──────────────────────────────────────────────────────────────

export function computeVolumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return 1;
  const avg = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  if (avg === 0) return 1;
  return Math.round((volumes[volumes.length - 1]! / avg) * 100) / 100;
}

// ── Swing points (10 candles before today, excl. last 1) ─────────────────────

function computeSwingPoints(candles: OHLCV[]): { swingLow: number; swingHigh: number } {
  const lookback = candles.slice(-11, -1);
  if (lookback.length === 0) return { swingLow: candles[candles.length - 1]!.low, swingHigh: candles[candles.length - 1]!.high };
  return {
    swingLow: Math.min(...lookback.map(c => c.low)),
    swingHigh: Math.max(...lookback.map(c => c.high)),
  };
}

// ── VWAP (Rolling 20-period) ─────────────────────────────────────────────────

// eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
export function computeRollingVWAP(candles: OHLCV[], _period = 20): number[] {
  const result: number[] = [];
  let cumVol = 0;
  let cumTypVol = 0;
  let currentDay = "";

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const d = new Date(c.timestamp);
    // Convert to IST date string for day detection
    const dayStr = d.toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });

    // Reset VWAP at start of new trading session
    if (dayStr !== currentDay) {
      currentDay = dayStr;
      cumVol = 0;
      cumTypVol = 0;
    }

    const typ = (c.high + c.low + c.close) / 3;
    cumVol += c.volume;
    cumTypVol += typ * c.volume;

    result.push(cumVol > 0 ? cumTypVol / cumVol : c.close);
  }
  return result;
}

// ── SuperTrend (10, 3) ───────────────────────────────────────────────────────

export function computeSuperTrend(candles: OHLCV[], period = 10, multiplier = 3): number[] {
  if (candles.length < period) return candles.map(c => c.close);
  
  const atrs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      atrs.push(candles[i]!.high - candles[i]!.low);
    } else {
      const h = candles[i]!.high;
      const l = candles[i]!.low;
      const pc = candles[i-1]!.close;
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      if (i < period) {
        atrs.push((atrs[i-1]! * i + tr) / (i + 1));
      } else {
        atrs.push((atrs[i-1]! * (period - 1) + tr) / period);
      }
    }
  }

  const result: number[] = [];
  let isUpTrend = true;
  let finalUpper = 0;
  let finalLower = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const hl2 = (c.high + c.low) / 2;
    const atr = atrs[i]!;
    
    const basicUpper = hl2 + multiplier * atr;
    const basicLower = hl2 - multiplier * atr;

    if (i === 0) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      result.push(finalLower);
      continue;
    }

    const prevClose = candles[i-1]!.close;
    
    finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;

    if (c.close > finalUpper) isUpTrend = true;
    else if (c.close < finalLower) isUpTrend = false;
    
    result.push(isUpTrend ? finalLower : finalUpper);
  }
  
  return result;
}

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

// ── Snapshot ──────────────────────────────────────────────────────────────────

export function buildSnapshot(candles: OHLCV[]): TechnicalSnapshot | null {
  if (candles.length < 55) return null;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const ema9s = computeEMA(closes, 9);
  const ema20s = computeEMA(closes, 20);
  const ema50s = computeEMA(closes, 50);
  const ema200s = computeEMA(closes, 200);
  const last = candles.length - 1;

  const close = closes[last]!;
  const e9 = ema9s[last]!;
  const e20 = ema20s[last]!;
  const e50 = ema50s.length > last ? ema50s[last]! : close;
  const e200 = ema200s.length > last ? ema200s[last]! : close;

  const rsi14 = computeRSI(closes, 14);
  const atr14 = computeATR(candles.slice(-60), 14);
  const adx14 = computeADX(candles, 14);
  const volRatio = computeVolumeRatio(volumes);
  const vwaps = computeRollingVWAP(candles, 20);
  const sts = computeSuperTrend(candles, 10, 3);
  const vpvrPOC = calculateVPVR(candles.slice(-100));

  const vwap = vwaps[last]!;
  const superTrend = sts[last]!;

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
  };
}

// ── Long setup detectors ──────────────────────────────────────────────────────

export function detectBreakout(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  const last = candles[candles.length - 1]!;
  const recent20High = Math.max(...candles.slice(-21, -1).map(c => c.high));
  if (last.close <= recent20High) return null;
  if (snap.distFromEma20Pct > 10) return null;
  if (last.close < snap.vwap) return null; // Reject long if below VWAP

  const goodVolume = snap.volumeRatio >= 1.5;
  const strongVolume = snap.volumeRatio >= 2.0;
  const notOverbought = snap.rsi14 < 72;
  const trending = snap.trend === "UP";
  const near52wHigh = last.close >= snap.high52w * 0.995;
  const breaking52wHigh = last.close > snap.high52w;
  const momentumConfirm = snap.adx14 > 20;

  // Stricter Filter: Breakouts must have strong momentum or exceptionally good volume
  if (!momentumConfirm && !strongVolume) return null;

  const score = 3.5
    + (goodVolume ? 1.5 : 0)
    + (strongVolume ? 0.5 : 0)
    + (notOverbought ? 0.5 : 0)
    + (trending ? 1.5 : 0)
    + (snap.adx14 > 25 ? 0.5 : 0)
    + (near52wHigh ? 1.0 : 0)
    + (breaking52wHigh ? 1.5 : 0)
    + (snap.rsi14 > 55 ? 0.5 : 0);

  const entry = last.close;
  const swingStop = snap.swingLow * 0.997;
  // Use SuperTrend for dynamic trailing stop if valid, else fallback to swing
  const stop = snap.superTrend < entry ? Math.max(swingStop, snap.superTrend) : swingStop;
  const risk = entry - stop;
  if (risk <= 0 || risk > entry * 0.08) return null;
  const target1 = entry + 2 * risk;
  const target2 = entry + 3.5 * risk;
  const rr = (target1 - entry) / risk;

  const confluence: string[] = [];
  if (breaking52wHigh) confluence.push(`Breaking 52-week high (₹${snap.high52w.toFixed(0)}) — multi-month resistance cleared`);
  else confluence.push(`Breakout above ${recent20High.toFixed(0)} (20-day high)`);
  if (strongVolume) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x average — very strong conviction`);
  else if (goodVolume) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x average — confirmed breakout`);
  if (trending) confluence.push("Price above EMA9 > EMA20 > EMA50 — confirmed uptrend");
  if (snap.adx14 > 25) confluence.push(`ADX ${snap.adx14.toFixed(0)} — strong directional move`);
  confluence.push(`Price above VWAP (₹${snap.vwap.toFixed(2)}) — institutional trend alignment`);
  confluence.push(`Dynamic stop at ₹${stop.toFixed(0)} using SuperTrend/Swing logic`);

  return {
    setupType: "BREAKOUT", direction: "BUY",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}

export function detectPullback(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  const last = candles[candles.length - 1]!;
  if (snap.trend !== "UP") return null;

  const nearEma20 = snap.distFromEma20Pct >= -1.5 && snap.distFromEma20Pct <= 1.5;
  const rsiHealthy = snap.rsi14 >= 38 && snap.rsi14 <= 58;
  const aboveEma50 = last.close > snap.ema50;
  const quietPullback = snap.volumeRatio < 0.85;

  if (!nearEma20 || !aboveEma50) return null;
  if (snap.distFromEma20Pct > 5) return null;
  if (last.close < snap.vwap) return null; // VWAP must hold for long pullbacks

  const score = 3.5
    + (rsiHealthy ? 1.5 : 0)
    + (quietPullback ? 1.5 : 0)
    + (snap.adx14 > 20 ? 1.0 : 0)
    + (snap.trend === "UP" ? 1.5 : 0)
    + (last.close > snap.ema9 ? 0.5 : 0);

  const entry = last.close;
  const swingStop = snap.swingLow * 0.997;
  const stop = snap.superTrend < entry ? Math.max(swingStop, snap.superTrend) : swingStop;
  const risk = entry - stop;
  if (risk <= 0 || risk > entry * 0.08) return null;
  const target1 = entry + 2 * risk;
  const target2 = entry + 3 * risk;
  const rr = (target1 - entry) / risk;

  const confluence: string[] = [];
  confluence.push(`Pullback to EMA20 (₹${snap.ema20.toFixed(0)}) in established uptrend`);
  if (rsiHealthy) confluence.push(`RSI ${snap.rsi14.toFixed(0)} — healthy correction, momentum intact`);
  if (aboveEma50) confluence.push(`Price held above EMA50 — trend structure intact`);
  if (quietPullback) confluence.push(`Low-volume pullback (${snap.volumeRatio.toFixed(2)}x avg) — sellers not in control`);
  confluence.push(`Supported above VWAP (₹${snap.vwap.toFixed(2)})`);
  confluence.push(`Dynamic stop at ₹${stop.toFixed(0)}`);

  return {
    setupType: "PULLBACK", direction: "BUY",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}

export function detectMomentum(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  const last = candles[candles.length - 1]!;
  const aboveAllEmas = last.close > snap.ema9 && last.close > snap.ema20 && last.close > snap.ema50;
  const rsiMomentum = snap.rsi14 >= 55 && snap.rsi14 <= 70;
  const volumeConfirm = snap.volumeRatio >= 1.2;

  if (!aboveAllEmas || !rsiMomentum) return null;
  if (snap.distFromEma20Pct > 8) return null;

  const score = 2.5
    + (volumeConfirm ? 1.5 : 0)
    + (snap.trend === "UP" ? 2 : 0)
    + (snap.adx14 > 25 ? 1.5 : 0)
    + (snap.distFromEma20Pct < 5 ? 1.5 : 0)
    + (last.close > snap.ema200 ? 1.0 : 0);

  const entry = last.close;
  const swingStop = snap.swingLow * 0.997;
  const emaStop = snap.ema20 - snap.atr14 * 0.3;
  const stop = Math.max(swingStop, emaStop);
  const risk = entry - stop;
  if (risk <= 0 || risk > entry * 0.05) return null;
  const target1 = entry + 2 * risk;
  const target2 = entry + 3.5 * risk;
  const rr = (target1 - entry) / risk;

  const confluence: string[] = [];
  confluence.push(`Momentum continuation — price above EMA9/20/50 in uptrend`);
  if (rsiMomentum) confluence.push(`RSI ${snap.rsi14.toFixed(0)} — momentum zone, not overbought`);
  if (volumeConfirm) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x avg — buyers active`);
  if (snap.adx14 > 25) confluence.push(`ADX ${snap.adx14.toFixed(0)} — strong directional move`);

  return {
    setupType: "MOMENTUM_CONTINUATION", direction: "BUY",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}

export function detectEma9Reclaim(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 5) return null;
  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;

  const reclaimedEma9 = prev.close < snap.ema9 && last.close > snap.ema9;
  if (!reclaimedEma9) return null;
  if (snap.trend !== "UP") return null;

  const nearEma20 = Math.abs(snap.distFromEma20Pct) < 4;
  if (!nearEma20) return null;
  if (snap.distFromEma20Pct > 6) return null;

  const volumeOnReclaim = snap.volumeRatio >= 1.2;

  const score = 5
    + (snap.rsi14 > 45 && snap.rsi14 < 62 ? 1.5 : 0)
    + (volumeOnReclaim ? 1.5 : 0)
    + (snap.trend === "UP" ? 1.5 : 0)
    + (snap.adx14 > 20 ? 0.5 : 0);

  const entry = last.close;
  const swingStop = snap.swingLow * 0.997;
  const atrStop = entry - 1.5 * snap.atr14;
  const stop = Math.max(swingStop, atrStop);
  const risk = entry - stop;
  if (risk <= 0) return null;
  const target1 = entry + 2 * risk;
  const target2 = entry + 3 * risk;
  const rr = (target1 - entry) / risk;

  const confluence: string[] = [];
  confluence.push(`Reclaimed EMA9 (₹${snap.ema9.toFixed(0)}) after pullback — buyers re-entering at key level`);
  if (volumeOnReclaim) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x avg on reclaim — conviction behind the move`);
  if (nearEma20) confluence.push(`Near EMA20 (₹${snap.ema20.toFixed(0)}) — double support below entry`);

  return {
    setupType: "EMA9_RECLAIM", direction: "BUY",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}

// ── Short setup detectors ─────────────────────────────────────────────────────

export function detectBreakdown(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  const last = candles[candles.length - 1]!;
  const recent20Low = Math.min(...candles.slice(-21, -1).map(c => c.low));
  if (last.close >= recent20Low) return null;
  if (last.close > snap.vwap) return null; // Price must be below VWAP for short

  // Reject if already oversold — mean reversion risk
  if (snap.rsi14 < 28) return null;
  // Reject if too extended below EMA20 — late entry
  if (snap.distFromEma20Pct < -10) return null;

  const goodVolume = snap.volumeRatio >= 1.5;
  const strongVolume = snap.volumeRatio >= 2.0;
  const notOversold = snap.rsi14 > 35;
  const downtrend = snap.trend === "DOWN";
  const near52wLow = last.close <= snap.low52w * 1.005;
  const breaking52wLow = last.close < snap.low52w;

  const score = 3.5
    + (goodVolume ? 1.5 : 0)
    + (strongVolume ? 0.5 : 0)
    + (notOversold ? 0.5 : 0)
    + (downtrend ? 1.5 : 0)
    + (snap.adx14 > 25 ? 0.5 : 0)
    + (near52wLow ? 1.0 : 0)
    + (breaking52wLow ? 1.5 : 0)
    + (snap.rsi14 < 48 ? 0.5 : 0);

  const entry = last.close;
  // Stop above swing high
  const swingStop = snap.swingHigh * 1.003;
  // Use SuperTrend trailing stop if valid, else fallback to swing
  const stop = snap.superTrend > entry ? Math.min(swingStop, snap.superTrend) : swingStop;
  const risk = stop - entry;
  if (risk <= 0 || risk > entry * 0.08) return null;
  const target1 = entry - 2 * risk;
  const target2 = entry - 3.5 * risk;
  if (target1 <= 0) return null;
  const rr = (entry - target1) / risk;

  const confluence: string[] = [];
  if (breaking52wLow) confluence.push(`Breaking 52-week low (₹${snap.low52w.toFixed(0)}) — multi-month support breached`);
  else confluence.push(`Breakdown below ${recent20Low.toFixed(0)} (20-day low)`);
  if (strongVolume) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x average — strong selling conviction`);
  else if (goodVolume) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x average — confirmed breakdown`);
  if (downtrend) confluence.push("Price below EMA9 < EMA20 < EMA50 — confirmed downtrend");
  if (snap.adx14 > 25) confluence.push(`ADX ${snap.adx14.toFixed(0)} — strong directional move`);
  confluence.push(`Price below VWAP (₹${snap.vwap.toFixed(2)}) — institutional selling pressure`);
  confluence.push(`Dynamic stop at ₹${stop.toFixed(0)} using SuperTrend/Swing logic`);

  return {
    setupType: "BREAKDOWN", direction: "SELL",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}

export function detectBearMomentum(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  const last = candles[candles.length - 1]!;
  const belowAllEmas = last.close < snap.ema9 && last.close < snap.ema20 && last.close < snap.ema50;
  const rsiBearZone = snap.rsi14 >= 28 && snap.rsi14 <= 46;
  const volumeConfirm = snap.volumeRatio >= 1.2;

  if (!belowAllEmas || !rsiBearZone) return null;
  if (snap.distFromEma20Pct < -8) return null;
  if (last.close > snap.vwap) return null; // Reject if above VWAP

  const score = 2.5
    + (volumeConfirm ? 1.5 : 0)
    + (snap.trend === "DOWN" ? 2 : 0)
    + (snap.adx14 > 25 ? 1.5 : 0)
    + (snap.distFromEma20Pct > -5 ? 1.5 : 0)
    + (last.close < snap.ema200 ? 1.0 : 0);

  const entry = last.close;
  const swingStop = snap.swingHigh * 1.003;
  const stop = snap.superTrend > entry ? Math.min(swingStop, snap.superTrend) : swingStop;
  const risk = stop - entry;
  if (risk <= 0 || risk > entry * 0.05) return null;
  const target1 = entry - 2 * risk;
  const target2 = entry - 3.5 * risk;
  if (target1 <= 0) return null;
  const rr = (entry - target1) / risk;

  const confluence: string[] = [];
  confluence.push(`Bear momentum — price below EMA9/20/50 in downtrend`);
  if (rsiBearZone) confluence.push(`RSI ${snap.rsi14.toFixed(0)} — bearish momentum zone, not oversold`);
  if (volumeConfirm) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x avg — sellers active`);
  if (snap.adx14 > 25) confluence.push(`ADX ${snap.adx14.toFixed(0)} — strong directional move`);
  confluence.push(`Price remaining below VWAP (₹${snap.vwap.toFixed(2)})`);
  confluence.push(`Dynamic stop at ₹${stop.toFixed(0)}`);

  return {
    setupType: "BEAR_MOMENTUM", direction: "SELL",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}

export function detectEma9Rejection(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 5) return null;
  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;

  // Previous close was above EMA9, current close is below — rejection at EMA9
  const rejectedEma9 = prev.close > snap.ema9 && last.close < snap.ema9;
  if (!rejectedEma9) return null;
  if (snap.trend !== "DOWN") return null;

  const nearEma20 = Math.abs(snap.distFromEma20Pct) < 4;
  if (!nearEma20) return null;
  if (snap.distFromEma20Pct < -6) return null;

  const volumeOnRejection = snap.volumeRatio >= 1.2;

  const score = 5
    + (snap.rsi14 > 38 && snap.rsi14 < 55 ? 1.5 : 0)
    + (volumeOnRejection ? 1.5 : 0)
    + (snap.trend === "DOWN" ? 1.5 : 0)
    + (snap.adx14 > 20 ? 0.5 : 0);

  const entry = last.close;
  const swingStop = snap.swingHigh * 1.003;
  const atrStop = entry + 1.5 * snap.atr14;
  const stop = Math.min(swingStop, atrStop);
  const risk = stop - entry;
  if (risk <= 0) return null;
  const target1 = entry - 2 * risk;
  const target2 = entry - 3 * risk;
  if (target1 <= 0) return null;
  const rr = (entry - target1) / risk;

  const confluence: string[] = [];
  confluence.push(`Rejected at EMA9 (₹${snap.ema9.toFixed(0)}) in downtrend — sellers defending key level`);
  if (volumeOnRejection) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x avg on rejection — conviction from sellers`);
  if (nearEma20) confluence.push(`Near EMA20 (₹${snap.ema20.toFixed(0)}) — dual resistance above`);

  return {
    setupType: "EMA9_REJECTION", direction: "SELL",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}

// ── SMA ──────────────────────────────────────────────────────────────────────

export function computeSMA(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(values[i]!);
    } else {
      const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    }
  }
  return result;
}

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

// ── Bollinger Bands ──────────────────────────────────────────────────────────

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
}

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

// ── MACD ─────────────────────────────────────────────────────────────────────

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

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

// ── Advanced Setup Detectors ─────────────────────────────────────────────────

export function detectMacdCrossover(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 35) return null;
  const closes = candles.map(c => c.close);
  const macdResults = computeMACD(closes);
  const lastIdx = candles.length - 1;
  const last = macdResults[lastIdx]!;
  const prev = macdResults[lastIdx - 1]!;

  const bullishCross = prev.macd <= prev.signal && last.macd > last.signal;
  const bearishCross = prev.macd >= prev.signal && last.macd < last.signal;

  if (!bullishCross && !bearishCross) return null;

  const entry = candles[lastIdx]!.close;
  const direction = bullishCross ? "BUY" : "SELL";

  // Check trend alignment
  if (direction === "BUY" && snap.trend !== "UP") return null;
  if (direction === "SELL" && snap.trend !== "DOWN") return null;

  const baseScore = 6.8;
  const rsiFilter = direction === "BUY" ? (snap.rsi14 < 68 ? 1.0 : 0) : (snap.rsi14 > 32 ? 1.0 : 0);
  const volFilter = snap.volumeRatio > 1.2 ? 0.7 : 0;
  const score = Math.min(10, baseScore + rsiFilter + volFilter);

  const swingStop = direction === "BUY" ? snap.swingLow * 0.997 : snap.swingHigh * 1.003;
  const atrStop = direction === "BUY" ? entry - 1.8 * snap.atr14 : entry + 1.8 * snap.atr14;
  const stop = direction === "BUY" ? Math.max(swingStop, atrStop) : Math.min(swingStop, atrStop);
  const risk = Math.abs(entry - stop);
  if (risk <= 0 || risk > entry * 0.07) return null;

  const target1 = direction === "BUY" ? entry + 2.0 * risk : entry - 2.0 * risk;
  const target2 = direction === "BUY" ? entry + 3.0 * risk : entry - 3.0 * risk;
  if (target1 <= 0) return null;
  const rr = Math.abs(target1 - entry) / risk;

  const confluence = [
    `MACD Crossover: MACD line crossed ${direction === "BUY" ? "above" : "below"} Signal line on ${snap.trend.toLowerCase()}trend`,
    `RSI is in healthy zone at ${snap.rsi14.toFixed(0)}`,
  ];

  return {
    setupType: "MACD_CROSSOVER",
    direction,
    score,
    entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)),
    target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.join(". ") + ".",
    confluence,
  };
}

export function detectBollingerSqueezeBreakout(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 40) return null;
  const closes = candles.map(c => c.close);
  const bb = computeBollingerBands(closes);
  const lastIdx = candles.length - 1;
  const last = bb[lastIdx]!;
  const prev = bb[lastIdx - 1]!;

  // Squeeze detection: look at bandwidth over the last 15 periods (excluding today)
  const bandwidthHistory = bb.slice(-16, -1).map(b => b.bandwidth);
  const avgBandwidth = bandwidthHistory.reduce((a, b) => a + b, 0) / bandwidthHistory.length;

  // A squeeze is active if bandwidth is narrow and was contracting
  const isSqueezed = last.bandwidth < 0.08 || last.bandwidth < avgBandwidth * 0.90;
  if (!isSqueezed) return null;

  const entry = candles[lastIdx]!.close;
  const prevClose = candles[lastIdx - 1]!.close;

  const upperBreakout = prevClose <= prev.upper && entry > last.upper;
  const lowerBreakdown = prevClose >= prev.lower && entry < last.lower;

  if (!upperBreakout && !lowerBreakdown) return null;

  const direction = upperBreakout ? "BUY" : "SELL";

  // Squeezes require high volume to confirm breakout
  if (snap.volumeRatio < 1.4) return null;

  const baseScore = 7.2;
  const strongVolume = snap.volumeRatio >= 2.0 ? 1.0 : 0.5;
  const adxBoost = snap.adx14 > 22 ? 0.6 : 0;
  const score = Math.min(10, baseScore + strongVolume + adxBoost);

  const swingStop = direction === "BUY" ? snap.swingLow * 0.997 : snap.swingHigh * 1.003;
  const bandStop = direction === "BUY" ? last.middle * 0.998 : last.middle * 1.002;
  const stop = direction === "BUY" ? Math.max(swingStop, bandStop) : Math.min(swingStop, bandStop);
  const risk = Math.abs(entry - stop);
  if (risk <= 0 || risk > entry * 0.075) return null;

  const target1 = direction === "BUY" ? entry + 2.0 * risk : entry - 2.0 * risk;
  const target2 = direction === "BUY" ? entry + 3.2 * risk : entry - 3.2 * risk;
  if (target1 <= 0) return null;
  const rr = Math.abs(target1 - entry) / risk;

  const confluence = [
    `Bollinger Squeeze Breakout: Price broke ${direction === "BUY" ? "above Upper" : "below Lower"} Band after period of low volatility`,
    `Volume expansion confirmed with ${snap.volumeRatio.toFixed(1)}x average volume`,
  ];

  return {
    setupType: "BOLLINGER_SQUEEZE_BREAKOUT",
    direction,
    score,
    entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)),
    target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.join(". ") + ".",
    confluence,
  };
}

export function detectLiquiditySweep(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 50) return null;
  const last = candles[candles.length - 1]!;
  
  // Lookback window for structural liquidity (e.g. previous 45 candles, excluding the last 5)
  const lookback = candles.slice(-50, -5);
  const recent = candles.slice(-5);
  
  const swingLow = Math.min(...lookback.map(c => c.low));
  const swingHigh = Math.max(...lookback.map(c => c.high));
  
  let isBullishSweep = false;
  let isBearishSweep = false;
  
  // Bullish Sweep: Price drops below swingLow (sweeps liquidity) but closes back ABOVE it
  for (const c of recent) {
    if (c.low < swingLow && c.close > swingLow) {
      isBullishSweep = true;
    }
  }
  
  // Bearish Sweep: Price goes above swingHigh but closes back BELOW it
  for (const c of recent) {
    if (c.high > swingHigh && c.close < swingHigh) {
      isBearishSweep = true;
    }
  }
  
  if (!isBullishSweep && !isBearishSweep) return null;
  // If both happen, ignore (choppy)
  if (isBullishSweep && isBearishSweep) return null;
  
  const direction = isBullishSweep ? "BUY" : "SELL";
  
  // Must align with momentum
  if (direction === "BUY" && snap.trend === "DOWN") return null;
  if (direction === "SELL" && snap.trend === "UP") return null;
  
  // High volume increases validity
  const baseScore = 8.5; // Sweeps are highly accurate
  const volBoost = snap.volumeRatio > 1.5 ? 1.0 : 0;
  const score = Math.min(10, baseScore + volBoost);
  
  const entry = last.close;
  const stop = direction === "BUY" ? Math.min(...recent.map(c => c.low)) * 0.998 : Math.max(...recent.map(c => c.high)) * 1.002;
  const risk = Math.abs(entry - stop);
  
  if (risk <= 0 || risk > entry * 0.05) return null;
  
  const target1 = direction === "BUY" ? entry + 2.5 * risk : entry - 2.5 * risk;
  const target2 = direction === "BUY" ? entry + 4.0 * risk : entry - 4.0 * risk;
  const rr = Math.abs(target1 - entry) / risk;
  
  const confluence = [
    `Institutional Liquidity Sweep: Price pierced major structural ${direction === "BUY" ? "low" : "high"} and aggressively reclaimed the level`,
    `Stop hunts exhausted, paving way for strong ${direction === "BUY" ? "upward" : "downward"} expansion`
  ];
  
  return {
    setupType: "LIQUIDITY_SWEEP",
    direction,
    score,
    entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)),
    target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.join(". ") + ".",
    confluence
  };
}

export function aggregateDailyToWeekly(dailyCandles: OHLCV[]): OHLCV[] {
  if (dailyCandles.length < 10) return [];
  const sorted = [...dailyCandles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const map = new Map<string, OHLCV[]>();
  for (const c of sorted) {
    const d = new Date(c.timestamp);
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
