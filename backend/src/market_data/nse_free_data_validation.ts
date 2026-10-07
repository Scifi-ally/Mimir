const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function parseNseTradeDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const dmy = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw);
  if (!iso && !dmy) return null;
  const year = Number(iso?.[1] ?? dmy?.[3]);
  const month = iso ? Number(iso[2]) : MONTHS.indexOf(dmy![2]!.toUpperCase()) + 1;
  const day = Number(iso?.[3] ?? dmy?.[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(date.getTime()) || date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
  ) return null;
  return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
