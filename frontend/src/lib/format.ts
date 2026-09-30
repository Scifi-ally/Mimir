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
  const num = toNumber(value, NaN);
  if (Number.isNaN(num)) return "—";
  return num.toFixed(decimals);
}

/**
 * Safely formats a percentage with sign
 */
export function toFixedPct(value: unknown, decimals = 2): string {
  const num = toNumber(value, NaN);
  if (Number.isNaN(num)) return "—";
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
    return `0.${"0".repeat(decimals)}%`;
  }
  const actualDecimals = (decimals === 1 && Math.abs(num) < 0.1) ? 2 : decimals;
  return `${num > 0 ? "+" : ""}${num.toFixed(actualDecimals)}%`;
}

/**
 * Compact INR for metric tiles.
 *
 * `fmtNum` renders 10000 as "10,000.00", which is ten characters and gets
 * ellipsised to "10,000…" in the narrow paper-trading metric row. Large values
 * are abbreviated in Indian convention (10.0k / 1.20L / 1.5Cr), which is also
 * how the figure is normally read; the exact amount stays available on the
 * tile's title attribute. Small values keep full precision, where abbreviating
 * would only lose information.
 */
export function fmtInr(value: unknown, opts?: { compact?: boolean }): string {
  const num = toNumber(value, NaN);
  if (Number.isNaN(num)) return "—";

  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";

  if (opts?.compact === false || abs < 1000) {
    return `${sign}₹${Math.abs(num).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  const units: Array<[number, string]> = [
    [1e7, "Cr"],
    [1e5, "L"],
    [1e3, "k"],
  ];
  for (const [divisor, suffix] of units) {
    if (abs >= divisor) {
      const scaled = abs / divisor;
      const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
      return `${sign}₹${scaled.toFixed(decimals)}${suffix}`;
    }
  }
  return `${sign}₹${abs.toFixed(2)}`;
}



