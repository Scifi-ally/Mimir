const IST_OFFSET_MS = 330 * 60 * 1000;

export function getISTDateStr(date = new Date()): string {
  const istMs = date.getTime() + IST_OFFSET_MS;
  return new Date(istMs).toISOString().split("T")[0]!;
}

export function getPreviousTradingDayStr(date = new Date()): string {
  const istMs = date.getTime() + IST_OFFSET_MS;
  const previous = new Date(istMs);
  previous.setUTCDate(previous.getUTCDate() - 1);
  while (previous.getUTCDay() === 0 || previous.getUTCDay() === 6) {
    previous.setUTCDate(previous.getUTCDate() - 1);
  }
  return previous.toISOString().split("T")[0]!;
}

export function getLastCompletedTradingDayStr(reference = new Date()): string {
  const istMs = reference.getTime() + IST_OFFSET_MS;
  const ist = new Date(istMs);
  const isBeforeMarketClose =
    ist.getUTCHours() < 15 ||
    (ist.getUTCHours() === 15 && ist.getUTCMinutes() < 30);
  const candidate = new Date(ist);
  if (isBeforeMarketClose) {
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  return candidate.toISOString().split("T")[0]!;
}

export function todayStartUTC(): Date {
  const midnightISTMs =
    Math.floor((Date.now() + IST_OFFSET_MS) / 86_400_000) * 86_400_000 -
    IST_OFFSET_MS;
  return new Date(midnightISTMs);
}

export function getNextTradingDayStr(reference = new Date()): string {
  const istMs = reference.getTime() + IST_OFFSET_MS;
  const next = new Date(istMs);
  next.setUTCDate(next.getUTCDate() + 1);
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString().split("T")[0]!;
}

export function getISTDayBounds(istDateStr: string): {
  start: Date;
  end: Date;
} {
  const start = new Date(`${istDateStr}T00:00:00.000+05:30`);
  const end = new Date(`${istDateStr}T23:59:59.999+05:30`);
  return { start, end };
}

export function parseISTDate(istDateStr: string): Date {
  return new Date(`${istDateStr}T00:00:00.000+05:30`);
}

export function shiftISTDateStr(istDateStr: string, deltaDays: number): string {
  const d = parseISTDate(istDateStr);
  d.setDate(d.getDate() + deltaDays);
  return getISTDateStr(d);
}
