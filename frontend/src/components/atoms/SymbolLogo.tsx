import { cn } from "@/lib/format";

/**
 * Company badge for a symbol, shown in the right-hand symbol lists.
 *
 * There is no logo asset per ticker, so this renders a stable, colour-coded
 * monogram - the same affordance the reference design uses (initial in a tinted
 * square). The colour is derived from the symbol, so a given company always
 * looks the same, and the two letters are the recognisable part. Real SVG/PNG
 * logos can be dropped in later without changing any call site.
 */

const PALETTE = [
  "bg-emerald-500/15 text-emerald-400",
  "bg-sky-500/15 text-sky-400",
  "bg-violet-500/15 text-violet-400",
  "bg-amber-500/15 text-amber-400",
  "bg-rose-500/15 text-rose-400",
  "bg-teal-500/15 text-teal-400",
  "bg-indigo-500/15 text-indigo-400",
  "bg-fuchsia-500/15 text-fuchsia-400",
];

/** Stable string hash so the same symbol always maps to the same colour. */
function hashSymbol(symbol: string): number {
  let h = 0;
  const s = symbol.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** One or two letters: first character plus the first vowel, else first two. */
function monogram(symbol: string): string {
  const s = symbol.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!s) return "?";
  if (s.length === 1) return s;
  const second = s.slice(1).match(/[AEIOU]/);
  return (s[0] + (second ? second[0] : s[1])).toUpperCase();
}

interface SymbolLogoProps {
  symbol: string;
  size?: "sm" | "md";
  className?: string;
}

export function SymbolLogo({ symbol, size = "md", className }: SymbolLogoProps) {
  const color = PALETTE[hashSymbol(symbol) % PALETTE.length];
  const dims = size === "sm" ? "h-5 w-5 text-[9px]" : "h-7 w-7 text-[11px]";

  return (
    <span
      aria-hidden="true"
      title={symbol}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold leading-none select-none",
        dims,
        color,
        className,
      )}
    >
      {monogram(symbol)}
    </span>
  );
}
