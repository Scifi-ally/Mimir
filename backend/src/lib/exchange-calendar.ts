import calendar from "../market_data/nse_calendar.json";

const holidays = new Set(Object.values(calendar.holidays).flat());
const weekendSessions = new Set(calendar.normal_weekend_sessions);

/** Normal 09:15-15:30 equity sessions. Special evening sessions are excluded.
 * Calendar years outside the published file retain weekday-only compatibility;
 * callers must not describe those years as exchange-verified.
 */
export function isNseNormalSessionDate(date: string): boolean {
  if (weekendSessions.has(date)) return true;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5 && !holidays.has(date);
}
