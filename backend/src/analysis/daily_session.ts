/** NSE cash daily candles become observable at 15:30 IST, regardless of the
 * vendor's midnight/open timestamp convention. */
export function dailySessionDate(timestamp: string | number): string {
  const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  return new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export function dailyAvailableAt(timestamp: string): string {
  return `${dailySessionDate(timestamp)}T10:00:00.000Z`;
}
