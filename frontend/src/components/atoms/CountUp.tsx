import { useEffect, useRef, useState, memo } from "react";

/**
 * CountUp - smoothly animates a number toward its target.
 *
 * AnimatedNumber in this codebase deliberately updates instantly and only
 * flashes, which reads well for tick-by-tick price changes but makes the large
 * paper-trading balances look like a static table. This adds the eased
 * transition, so a balance or P&L figure visibly moves to its new value.
 *
 * Implemented with rAF + an ease-out cubic rather than a spring: these are
 * financial figures, and a spring overshoots - showing equity briefly above its
 * real value would be actively misleading.
 */
interface CountUpProps {
  value: number;
  /** Render the interpolated value. Receives the current animated number. */
  format?: (v: number) => string;
  durationMs?: number;
  className?: string;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export const CountUp = memo(function CountUp({
  value,
  format = (v) => v.toFixed(2),
  durationMs = 600,
  className,
}: CountUpProps) {
  const [display, setDisplay] = useState(() => (Number.isFinite(value) ? value : 0));
  const fromRef = useRef(Number.isFinite(value) ? value : 0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // Never let NaN or Infinity reach the DOM - a formatter like toFixed turns
    // them into the literal strings "NaN"/"Infinity", which look like a crash
    // in the middle of a metric tile. Hold the last known-good value instead;
    // if there is not one yet, fall back to 0.
    if (!Number.isFinite(value)) {
      if (!Number.isFinite(fromRef.current)) fromRef.current = 0;
      setDisplay(fromRef.current);
      return;
    }

    const from = fromRef.current;
    const to = value;

    if (from === to) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }

    // Same guard for a non-finite starting point: adopt the target outright.
    if (!Number.isFinite(from)) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }

    // Animate only when the change is small relative to the magnitude involved.
    // A first load (0 -> balance) or a close-out (balance -> 0) changes by 100%
    // of the value, and crawling through that reads as a bug, so snap instead.
    const change = Math.abs(to - from);
    const scale = Math.max(Math.abs(to), Math.abs(from));
    if (change < scale) {
      const start = performance.now();
      const step = (now: number) => {
        // Clamp BOTH ends. The rAF timestamp is not guaranteed to share an
        // epoch with performance.now() (jsdom demonstrably does not), and a
        // negative t makes easeOutCubic explode into a huge wrong number.
        const raw = (now - start) / durationMs;
        const t = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
        setDisplay(from + (to - from) * easeOutCubic(t));
        if (t < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          fromRef.current = to;
        }
      };
      rafRef.current = requestAnimationFrame(step);
    } else {
      fromRef.current = to;
      setDisplay(to);
    }

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      fromRef.current = to;
    };
  }, [value, durationMs]);

  return <span className={className}>{format(display)}</span>;
});
