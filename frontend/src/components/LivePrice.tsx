import { useRef, useEffect, memo } from "react";
import { motion, useSpring, useTransform, animate } from "framer-motion";

// ─── Animated Number with Countdown ────────────────────────────────
// Smoothly animates number changes with counting effect
function AnimatedNumber({ value, decimals = 2 }: { value: number; decimals?: number }) {
  const nodeRef = useRef<HTMLSpanElement>(null);
  const prevValueRef = useRef<number>(value);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node || value === prevValueRef.current) return;

    const controls = animate(prevValueRef.current, value, {
      duration: 0.4, // Fast animation
      ease: "easeOut",
      onUpdate(latest) {
        node.textContent = latest.toFixed(decimals);
      },
    });

    prevValueRef.current = value;
    return () => controls.stop();
  }, [value, decimals]);

  return <span ref={nodeRef}>{value.toFixed(decimals)}</span>;
}

// ─── Odometer Digit ────────────────────────────────────────────────
// Each digit independently animates by sliding up or down.
function OdometerDigit({ digit }: { digit: string }) {
  const numericValue = /\d/.test(digit) ? parseInt(digit, 10) : null;
  const spring = useSpring(numericValue ?? 0, {
    stiffness: 300, // Increased from 180 for faster response
    damping: 20,    // Reduced from 25 for snappier animation
    mass: 0.4,      // Reduced from 0.6 for lighter feel
  });

  useEffect(() => {
    if (numericValue !== null) spring.set(numericValue);
  }, [numericValue, spring]);

  const y = useTransform(spring, (v) => {
    const offset = v - (numericValue ?? 0);
    return `${-offset * 1.1}em`;
  });

  if (numericValue === null) {
    // Non-numeric characters (comma, dot) render statically
    return <span className="inline-block">{digit}</span>;
  }

  return (
    <span className="inline-block relative overflow-hidden" style={{ width: "0.62em", height: "1.1em", verticalAlign: "bottom" }}>
      <motion.span
        className="absolute left-0 tabular-nums"
        style={{ y }}
      >
        {digit}
      </motion.span>
    </span>
  );
}

// ─── LivePrice ─────────────────────────────────────────────────────
// Displays a price with:
//   1. Green/red flash on tick up/down
//   2. Odometer-style rolling digits
//   3. Fast tick updates

interface LivePriceProps {
  value: number | null | undefined;
  /** Format the number before display. Default: Indian locale with 2 decimals */
  format?: (v: number) => string;
  /** Extra class names applied to the container */
  className?: string;
  /** Prefix string, e.g. "₹" */
  prefix?: string;
  /** If true, show a +/- sign */
  showSign?: boolean;
  /** If true, always colour based on sign (green positive, red negative) */
  colorBySign?: boolean;
  /** Duration of the flash effect in ms (default 300) */
  flashDuration?: number;
  /** Use countdown animation instead of odometer (default false) */
  useCountdown?: boolean;
}

const defaultFormat = (v: number) =>
  v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const LivePrice = memo(function LivePrice({
  value,
  format = defaultFormat,
  className = "",
  prefix = "",
  showSign = false,
  colorBySign = false,
  flashDuration = 300, // Reduced from 600ms for faster flash
  useCountdown = false,
}: LivePriceProps) {
  const prevValueRef = useRef<number | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLSpanElement>(null);

  // Flash effect and direction check via DOM manipulation inside useEffect (avoids accessing ref during render)
  useEffect(() => {
    if (value == null || prevValueRef.current == null || value === prevValueRef.current || !containerRef.current) {
      if (value != null) prevValueRef.current = value;
      return;
    }

    const direction = value > prevValueRef.current ? "up" : "down";
    prevValueRef.current = value;

    const el = containerRef.current;
    el.classList.remove("flash-up", "flash-down");
    void el.offsetWidth;
    el.classList.add(direction === "up" ? "flash-up" : "flash-down");

    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = setTimeout(() => {
      el.classList.remove("flash-up", "flash-down");
    }, flashDuration);
  }, [value, flashDuration]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  if (value == null) {
    return <span className={`tabular-nums ${className}`}>—</span>;
  }

  // Use countdown animation for simple numbers
  if (useCountdown) {
    const sign = showSign && value > 0 ? "+" : showSign && value < 0 ? "" : "";
    const decimals = format(value).split('.')[1]?.length || 2;
    
    return (
      <span
        ref={containerRef}
        className={`inline-flex tabular-nums transition-colors duration-100 ${
          colorBySign
            ? value > 0
              ? "text-bull"
              : value < 0
                ? "text-bear"
                : ""
            : ""
        } ${className}`}
      >
        {prefix}{sign}<AnimatedNumber value={value} decimals={decimals} />
      </span>
    );
  }

  const formatted = format(value);
  const sign = showSign && value > 0 ? "+" : showSign && value < 0 ? "" : ""; // negative sign is in the formatted string
  const displayStr = `${prefix}${sign}${formatted}`;

  // Split into individual characters for odometer
  const chars = displayStr.split("");

  // Determine static colour from sign
  const signColor = colorBySign
    ? value > 0
      ? "text-bull"
      : value < 0
        ? "text-bear"
        : ""
    : "";

  return (
    <span
      ref={containerRef}
      className={`inline-flex tabular-nums transition-colors duration-100 ${signColor} ${className}`}
    >
      {chars.map((char, i) => (
        <OdometerDigit key={`${i}-${char}`} digit={char} />
      ))}
    </span>
  );
});

export { AnimatedNumber };
