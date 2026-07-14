import { useRef, useEffect, memo } from "react";
import { animate } from "framer-motion";

interface AnimatedNumberProps {
  value: number | null | undefined;
  decimals?: number;
  className?: string;
  prefix?: string;
  suffix?: string;
  showSign?: boolean;
  duration?: number;
  formatFn?: (value: number) => string;
  flashColor?: boolean;
}

/**
 * AnimatedNumber - Smooth counting animation with flash effects
 * 
 * Features:
 * - Counts up/down smoothly when value changes
 * - Flashes green on increase, red on decrease
 * - Customizable speed, decimals, and formatting
 * - Performance optimized with memo and refs
 */
export const AnimatedNumber = memo(function AnimatedNumber({
  value,
  decimals = 2,
  className = "",
  prefix = "",
  suffix = "",
  showSign = false,
  duration = 0.4,
  formatFn,
  flashColor = true,
}: AnimatedNumberProps) {
  const nodeRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLSpanElement>(null);
  const prevValueRef = useRef<number | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const node = nodeRef.current;
    const container = containerRef.current;
    
    if (!node || value == null) {
      if (node) node.textContent = "—";
      return;
    }

    // Determine if going up or down for flash
    if (prevValueRef.current != null && value !== prevValueRef.current && flashColor && container) {
      const direction = value > prevValueRef.current ? "up" : "down";
      container.classList.remove("flash-up", "flash-down");
      void container.offsetWidth; // Force reflow
      container.classList.add(direction === "up" ? "flash-up" : "flash-down");
      
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => {
        container.classList.remove("flash-up", "flash-down");
      }, 300);
    }

    // Animate the number
    if (prevValueRef.current === null || prevValueRef.current === value) {
      // First render or no change - set immediately
      const formatted = formatFn 
        ? formatFn(value)
        : value.toFixed(decimals);
      const sign = showSign && value > 0 ? "+" : "";
      node.textContent = `${sign}${formatted}`;
      prevValueRef.current = value;
      return;
    }

    // Animate from previous to current
    const controls = animate(prevValueRef.current, value, {
      duration,
      ease: "easeOut",
      onUpdate(latest) {
        const formatted = formatFn
          ? formatFn(latest)
          : latest.toFixed(decimals);
        const sign = showSign && latest > 0 ? "+" : "";
        node.textContent = `${sign}${formatted}`;
      },
    });

    prevValueRef.current = value;
    return () => controls.stop();
  }, [value, decimals, showSign, duration, formatFn, flashColor]);

  if (value == null) {
    return <span className={`tabular-nums ${className}`}>—</span>;
  }

  return (
    <span ref={containerRef} className={`inline-flex items-center tabular-nums ${className}`}>
      {prefix && <span className="mr-[0.1em]">{prefix}</span>}
      <span ref={nodeRef} />
      {suffix && <span className="ml-[0.1em]">{suffix}</span>}
    </span>
  );
});

export default AnimatedNumber;
