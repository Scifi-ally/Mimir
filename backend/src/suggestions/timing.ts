export interface SuggestionTimingInput {
  tradeType: "INTRADAY" | "SWING";
  entryPrice: number;
  target1: number;
  atr?: number | null;
  generatedAt?: Date;
}

export interface SuggestionTiming {
  expectedHoldMinutes: number;
  expiresAt: Date;
  validityTill: string;
}

const MINUTE = 60_000;
const MARKET_CLOSE_MINUTES_IST = 15 * 60 + 15;

function getMinutesInIST(date: Date): number {
  return (date.getUTCHours() * 60 + date.getUTCMinutes() + 330) % (24 * 60);
}

function intradayExpiry(generatedAt: Date, estimatedMinutes: number): Date {
  const closeInMinutes = MARKET_CLOSE_MINUTES_IST - getMinutesInIST(generatedAt);
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

  if (input.tradeType === "INTRADAY") {
    const expectedHoldMinutes = Math.round(Math.max(30, Math.min(240, targetAtrMultiple * 90)) / 5) * 5;
    const expiresAt = intradayExpiry(generatedAt, Math.round(expectedHoldMinutes * 1.5));
    return {
      expectedHoldMinutes,
      expiresAt,
      validityTill: expiresAt.toISOString().slice(0, 10),
    };
  }

  const expectedHoldMinutes = Math.round(Math.max(390, Math.min(3 * 390, targetAtrMultiple * 390)) / 30) * 30;
  const expiresAt = new Date(generatedAt.getTime() + Math.min(expectedHoldMinutes * 1.5, 3 * 24 * 60) * MINUTE);
  return {
    expectedHoldMinutes,
    expiresAt,
    validityTill: expiresAt.toISOString().slice(0, 10),
  };
}
