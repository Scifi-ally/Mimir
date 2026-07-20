import { useRef, useEffect, memo } from "react";

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
 * AnimatedNumber - Number display with flash effects on change
 * 
 * Features:
 * - Updates immediately when value changes without countdown/counting effect
 * - Flashes green on increase, red on decrease
 * - Customizable decimals and formatting
 * - Performance optimized with memo and refs
 */
export const AnimatedNumber = memo(function AnimatedNumber({
  value,
  decimals = 2,
  className = "",
  prefix = "",
  suffix = "",
  showSign = false,
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

    // Update value directly without countdown/counting animation
    const formatted = formatFn 
      ? formatFn(value)
      : value.toFixed(decimals);
    const sign = showSign && value > 0 ? "+" : "";
    node.textContent = `${sign}${formatted}`;
    prevValueRef.current = value;
  }, [value, decimals, showSign, formatFn, flashColor]);

  if (value == null) {
    return <span className={`font-mono tabular-nums ${className}`}>—</span>;
  }

  return (
    <span ref={containerRef} className={`inline-flex items-center font-mono tabular-nums ${className}`}>
      {prefix && <span className="mr-[0.1em]">{prefix}</span>}
      <span ref={nodeRef} />
      {suffix && <span className="ml-[0.1em]">{suffix}</span>}
    </span>
  );
});

export default AnimatedNumber;
