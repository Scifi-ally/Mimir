export type MarketRegime =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "VOLATILE"
  | "RANGING"
  | "UNKNOWN";

export type SessionPhase =
  | "PRE_MARKET"   // 08:00–09:14 IST weekdays
  | "MARKET"       // 09:15–15:29 IST weekdays
  | "POST_MARKET"  // 15:30–17:59 IST weekdays
  | "OFF_HOURS";   // all other times (nights, weekends)

export interface SectorData {
  name: string;
  changePct: number;
}

export interface MarketState {
  regime: MarketRegime;
  sessionPhase: SessionPhase;
  niftyPrice: number | null;
  niftyChangePct: number | null;
  indiaVix: number | null;
  advanceCount: number;
  declineCount: number;
  topSectors: SectorData[];
  updatedAt: Date;
  suggestionsPaused: boolean;
  pauseReason: string | null;
  isMarketOpen: boolean;
  fiiNetInr: number | null;
  diiNetInr: number | null;
  corporateActionSymbols: Set<string>;
  decisionReason?: string;
  inputsForced?: boolean;
}

const state: MarketState = {
  regime: "UNKNOWN",
  sessionPhase: "OFF_HOURS",
  niftyPrice: null,
  niftyChangePct: null,
  indiaVix: null,
  advanceCount: 0,
  declineCount: 0,
  topSectors: [],
  updatedAt: new Date(),
  suggestionsPaused: false,
  pauseReason: null,
  isMarketOpen: false,
  fiiNetInr: null,
  diiNetInr: null,
  corporateActionSymbols: new Set(),
  decisionReason: "Initializing regime engine...",
  inputsForced: false,
};

export function getMarketState(): MarketState {
  return { ...state, corporateActionSymbols: new Set(state.corporateActionSymbols) };
}

export function updateMarketState(partial: Partial<MarketState>): void {
  Object.assign(state, partial, { updatedAt: new Date() });
}

// ── IST helpers ──────────────────────────────────────────────────────────────

const NSE_HOLIDAYS = new Set([
  // 2026 NSE Holidays
  "2026-01-26", // Republic Day
  "2026-03-03", // Maha Shivaratri
  "2026-03-24", // Holi
  "2026-04-02", // Mahavir Jayanti
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-06-26", // Moharram
  "2026-08-15", // Independence Day
  "2026-09-07", // Ganesh Chaturthi
  "2026-10-02", // Mahatma Gandhi Jayanti
  "2026-10-21", // Dussehra
  "2026-11-09", // Diwali
  "2026-11-23", // Gurunanak Jayanti
  "2026-12-25", // Christmas
]);

/** Returns current time as { day (0=Sun), totalMinutesIST, dateString } */
function getISTTime(date: Date = new Date()): { day: number; totalMinutes: number; dateString: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  
  const dateString = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);

  return { day: dayMap[weekday] ?? 0, totalMinutes: hour * 60 + minute, dateString };
}

function isTradingDay(day: number, dateString: string): boolean {
  if (day < 1 || day > 5) return false; // Weekend
  if (NSE_HOLIDAYS.has(dateString)) return false;
  return true;
}

export function computeSessionPhase(): SessionPhase {
  const { day, totalMinutes, dateString } = getISTTime();
  if (!isTradingDay(day, dateString)) return "OFF_HOURS";

  // Market: 09:15–15:29 IST
  if (totalMinutes >= 9 * 60 + 15 && totalMinutes < 15 * 60 + 30) return "MARKET";
  // Pre-market: 08:00–09:14 IST
  if (totalMinutes >= 8 * 60 && totalMinutes < 9 * 60 + 15) return "PRE_MARKET";
  // Post-market: 15:30–17:59 IST
  if (totalMinutes >= 15 * 60 + 30 && totalMinutes < 18 * 60) return "POST_MARKET";
  return "OFF_HOURS";
}

export function isMarketOpen(): boolean {
  return computeSessionPhase() === "MARKET";
}

/** Minutes until next market open from now (IST). Returns null if open. */
export function minutesUntilOpen(): number | null {
  if (computeSessionPhase() === "MARKET") return null;

  const now = new Date();
  const { day, totalMinutes, dateString } = getISTTime(now);
  const openMinutes = 9 * 60 + 15;

  // If today is a trading day and it's before market open
  if (isTradingDay(day, dateString) && totalMinutes < openMinutes) {
    return openMinutes - totalMinutes;
  }

  // Calculate minutes until next trading day at 09:15
  const minutesLeftToday = 24 * 60 - totalMinutes;
  let daysUntilTradingDay = 0;
  
  let nextDayInfo;
  
  do {
    daysUntilTradingDay++;
    const nextDate = new Date(now.getTime() + daysUntilTradingDay * 86400000);
    nextDayInfo = getISTTime(nextDate);
  } while (!isTradingDay(nextDayInfo.day, nextDayInfo.dateString) && daysUntilTradingDay < 30);

  return minutesLeftToday + (daysUntilTradingDay - 1) * 24 * 60 + openMinutes;
}

/** Dashboard-facing session (distinct from raw SessionPhase). */
export type DashboardSession = "PRE_MARKET" | "OPEN" | "CLOSED" | "POST_MARKET_SCAN";

export function computeDashboardSession(): DashboardSession {
  const phase = computeSessionPhase();
  if (phase === "MARKET") return "OPEN";
  if (phase === "PRE_MARKET") return "PRE_MARKET";

  const { day, totalMinutes, dateString } = getISTTime();
  // Post-market scan window: 15:31–16:15 IST weekdays
  if (
    isTradingDay(day, dateString) &&
    totalMinutes >= 15 * 60 + 31 &&
    totalMinutes < 16 * 60 + 15
  ) {
    return "POST_MARKET_SCAN";
  }

  return "CLOSED";
}

export function formatMinutesAsCountdown(minutes: number | null): string | null {
  if (minutes == null || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function updateMarketOpenStatus(): void {
  const phase = computeSessionPhase();
  state.isMarketOpen = phase === "MARKET";
  state.sessionPhase = phase;
}
