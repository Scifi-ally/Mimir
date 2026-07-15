import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Safely converts a value to a number, with fallback
 */
export function toNumber(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  const num = Number(value);
  return Number.isNaN(num) || !Number.isFinite(num) ? fallback : num;
}

/**
 * Safely formats a number to fixed decimals, preventing NaN
 */
export function toFixed(value: unknown, decimals = 2): string {
  const num = toNumber(value, 0);
  return num.toFixed(decimals);
}

/**
 * Safely formats a percentage with sign
 */
export function toFixedPct(value: unknown, decimals = 2): string {
  const num = toNumber(value, 0);
  const sign = num >= 0 ? '+' : '';
  return `${sign}${num.toFixed(decimals)}%`;
}

export function fmtNum(value: unknown, decimals = 2) {
  const num = toNumber(value, NaN);
  if (Number.isNaN(num)) return "—";
  return num.toLocaleString("en-IN", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

export function fmtPct(value: unknown, decimals: number = 1) {
  const num = toNumber(value, NaN);
  if (Number.isNaN(num)) return "—";
  if (num === 0 || Math.abs(num) < Math.pow(10, -(decimals + 1))) {
    return `${num >= 0 ? "+" : ""}0.${"0".repeat(decimals)}%`;
  }
  const actualDecimals = (decimals === 1 && Math.abs(num) < 0.1) ? 2 : decimals;
  return `${num > 0 ? "+" : ""}${num.toFixed(actualDecimals)}%`;
}

export function calcPnLPct(current: unknown, entry: unknown): number | null {
  const curNum = toNumber(current, NaN);
  const entNum = toNumber(entry, NaN);
  if (!Number.isNaN(curNum) && !Number.isNaN(entNum) && entNum > 0) {
    return ((curNum - entNum) / entNum) * 100;
  }
  return null;
}
