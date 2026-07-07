import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtNum(value: number | null | undefined, decimals = 2) {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-IN", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

export function fmtPct(value: number | null | undefined, decimals: number = 1) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

export function calcPnLPct(current: number | null | undefined, entry: number | null | undefined): number | null {
  if (current != null && entry != null && entry > 0) {
    return ((current - entry) / entry) * 100;
  }
  return null;
}
