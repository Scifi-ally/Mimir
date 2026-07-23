export interface SuggestionTimingInput {
  tradeType: "INTRADAY" | "SWING";
  entryPrice: number;
  target1: number;
  atr?: number | null;
  generatedAt?: Date;
  // Realized median minutes-to-target for this setup (calibration_engine).
  // When present it overrides the ATR heuristic — measurement beats model.
  empiricalMedianMinutes?: number | null;
}

export interface SuggestionTiming {
  expectedHoldMinutes: number;
  expiresAt: Date;
  validityTill: string;
}

const MINUTE = 60_000;
const MARKET_CLOSE_MINUTES_IST = 15 * 60 + 15;
const MARKET_OPEN_MINUTES_IST = 9 * 60 + 15;

function getMinutesInIST(date: Date): number {
  return (date.getUTCHours() * 60 + date.getUTCMinutes() + 330) % (24 * 60);
}

function intradayExpiry(generatedAt: Date, estimatedMinutes: number): Date {
  const nowIST = getMinutesInIST(generatedAt);
  const closeInMinutes = MARKET_CLOSE_MINUTES_IST - nowIST;

  if (closeInMinutes <= 5) {
    // Generated after (or at) close — off-hours scans target the NEXT session.
    // Previously this clamped to 0 minutes and the suggestion expired instantly.
    let minutesUntilOpen = (MARKET_OPEN_MINUTES_IST - nowIST + 24 * 60) % (24 * 60);
    // Skip weekend days between now and the next open
    const opensAt = new Date(generatedAt.getTime() + minutesUntilOpen * MINUTE);
    let day = new Date(opensAt.getTime() + 330 * MINUTE).getUTCDay();
    while (day === 0 || day === 6) {
      minutesUntilOpen += 24 * 60;
      day = (day + 1) % 7;
    }
    const sessionMinutes = MARKET_CLOSE_MINUTES_IST - MARKET_OPEN_MINUTES_IST - 5;
    return new Date(
      generatedAt.getTime() +
        (minutesUntilOpen + Math.min(estimatedMinutes, sessionMinutes)) * MINUTE,
    );
  }

  const maxDuration = Math.max(0, closeInMinutes - 5);
  return new Date(generatedAt.getTime() + Math.min(estimatedMinutes * MINUTE, maxDuration * MINUTE));
}

/**
 * Produces a bounded planning horizon from the distance to target in ATR units.
 * It is intentionally a transparent baseline; outcome data can later calibrate it
 * by setup, regime, and time of day without changing the signal lifecycle.
 */
export function calculateSuggestionTiming(input: SuggestionTimingInput): SuggestionTiming {
  const generatedAt = input.generatedAt ?? new Date();
  const distance = Math.abs(input.target1 - input.entryPrice);
  const atr = input.atr != null && input.atr > 0 ? input.atr : Math.max(input.entryPrice * 0.01, distance);
  const targetAtrMultiple = Math.max(0.25, distance / atr);

  const empirical = input.empiricalMedianMinutes;

  if (input.tradeType === "INTRADAY") {
    // A momentum burst or gap-fill doesn't take 90 minutes per ATR; typical intraday moves happen in 45m-60m per ATR.
    // We adjust the heuristic to 60m per ATR to give more variation instead of always hitting the 240m cap.
    const heuristic = Math.max(30, Math.min(240, targetAtrMultiple * 60));
    // Blend 60/40 toward realized outcomes when we have them
    const blended = empirical != null && empirical > 0
      ? Math.max(30, Math.min(240, empirical * 0.6 + heuristic * 0.4))
      : heuristic;
    let expectedHoldMinutes = Math.round(blended / 5) * 5;

    // INTRADAY trades are force-closed at the end of the session. 
    // The hold time cannot exceed the time remaining before the 3:15 PM cutoff.
    const nowIST = getMinutesInIST(generatedAt);
    const closeInMinutes = MARKET_CLOSE_MINUTES_IST - nowIST;
    // Only cap if we are currently inside the active trading window (between Open and Close)
    if (closeInMinutes > 5 && nowIST >= MARKET_OPEN_MINUTES_IST) {
      expectedHoldMinutes = Math.min(expectedHoldMinutes, closeInMinutes - 5);
    }

    const expiresAt = intradayExpiry(generatedAt, Math.round(expectedHoldMinutes * 1.5));
    return {
      expectedHoldMinutes,
      expiresAt,
      validityTill: expiresAt.toISOString().slice(0, 10),
    };
  }

  // Backtest (scripts/backtest_setups.ts): swing expectancy flips positive only
  // past ~10 trading days and peaks near 20. A short expiry closes trades before
  // the move completes, so give swings up to 10 trading days (14 calendar).
  const swingHeuristic = Math.max(390, Math.min(10 * 390, targetAtrMultiple * 390));
  const swingBlended = empirical != null && empirical > 0
    ? Math.max(390, Math.min(10 * 390, empirical * 0.6 + swingHeuristic * 0.4))
    : swingHeuristic;
  const expectedHoldMinutes = Math.round(swingBlended / 30) * 30;
  // expectedHoldMinutes counts TRADING minutes (390/day). Convert to calendar
  // time: 1 trading day ≈ 1.4 calendar days (weekends), plus buffer, cap 14d.
  const tradingDays = expectedHoldMinutes / 390;
  const calendarDays = Math.min(14, Math.ceil(tradingDays * 1.4) + 1);
  const expiresAt = new Date(generatedAt.getTime() + calendarDays * 24 * 60 * MINUTE);
  return {
    expectedHoldMinutes,
    expiresAt,
    validityTill: expiresAt.toISOString().slice(0, 10),
  };
}
