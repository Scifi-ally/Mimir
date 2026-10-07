import type { OHLCV } from "./types";
import { getLastCompletedTradingDayStr } from "../lib/ist-time";
import { dailyAvailableAt, dailySessionDate } from "./daily_session";

export function assessSignalData(candles: OHLCV[], now = new Date()): string | null {
  if (candles.length < 201) return "insufficient_indicator_history";
  let previous = -Infinity;
  let previousSession = "";
  for (const bar of candles) {
    const ts = Date.parse(bar.timestamp);
    if (!Number.isFinite(ts) || ts <= previous || ts > now.getTime()) return "invalid_candle_timestamps";
    previous = ts;
    const session = dailySessionDate(bar.timestamp);
    if (session <= previousSession) return "duplicate_daily_session";
    if (Date.parse(dailyAvailableAt(bar.timestamp)) > now.getTime()) return "incomplete_daily_session";
    previousSession = session;
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.low <= 0 || bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close) || bar.volume < 0) return "invalid_ohlcv";
  }
  const last = candles[candles.length - 1]!;
  const lastDate = new Date(Date.parse(last.timestamp) + 5.5 * 3600_000).toISOString().slice(0, 10);
  // A weekday calendar can over-reject exchange holidays. That is safe; an
  // absent official holiday calendar must never relax a stale-data check.
  if (lastDate < getLastCompletedTradingDayStr(now)) return "stale_daily_candles";
  if (candles.slice(-20).some(c => c.volume <= 0)) return "unmeasured_equity_volume";
  return null;
}
