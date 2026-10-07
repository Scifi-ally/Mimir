import { parseISTDate } from "../lib/ist-time";

export function normalizeInstitutionalFlowCategory(value: unknown): "FII" | "DII" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\*+$/, "").trim().toUpperCase();
  if (normalized === "FII/FPI") return "FII";
  if (normalized === "DII") return "DII";
  return null;
}

/** Parse NSE's source report date without treating a missing/invalid value as today. */
export function parseInstitutionalFlowSourceDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  let year: number;
  let month: number;
  let day: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(raw);
  const dmy = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw);
  const numericDmy = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(raw);
  if (iso) {
    year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]);
  } else if (dmy) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    month = months.indexOf(dmy[2]!.toLowerCase()) + 1;
    day = Number(dmy[1]); year = Number(dmy[3]);
  } else if (numericDmy) {
    day = Number(numericDmy[1]); month = Number(numericDmy[2]); year = Number(numericDmy[3]);
  } else {
    return null;
  }

  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(candidate.getTime()) ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function isUsableInstitutionalFlowSourceDate(sourceDate: string, today: string): boolean {
  if (sourceDate > today) return false;
  const ageMs = parseISTDate(today).getTime() - parseISTDate(sourceDate).getTime();
  // Permit weekends and a nearby exchange holiday, but refuse week-old flows.
  return ageMs >= 0 && ageMs <= 4 * 24 * 60 * 60 * 1000;
}

/** NSE netValue is reported in INR crores; keep that source unit unchanged. */
export function parseInstitutionalFlowNetValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return null;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
