import { memo, useEffect, useRef, useMemo } from 'react';
import { cn, fmtPct } from '@/lib/format';
import { useSymbolDataSelector } from '@/providers/MarketDataProvider';
import { useStore } from '@/store/useStore';

interface LiveChangePctProps {
  symbol: string;
  className?: string;
  decimals?: number;
  fallback?: number | null;
}

const INDEX_MAP: Record<string, string[]> = {
  "NIFTY 50": ["nifty", "nifty50"],
  "NIFTY": ["nifty", "nifty50"],
  "SENSEX": ["sensex"],
  "BANK NIFTY": ["banknifty", "bankNifty"],
  "BANKNIFTY": ["banknifty", "bankNifty"],
  "FIN NIFTY": ["finnifty"],
  "FINNIFTY": ["finnifty"],
  "INDIA VIX": ["vix", "indiaVix"],
  "VIX": ["vix", "indiaVix"],
};

export const LiveChangePct = memo(({ symbol, className, decimals = 2, fallback }: LiveChangePctProps) => {
  const storeKeys = INDEX_MAP[symbol?.toUpperCase() || ""] || [];
  const indexChange = useStore((s) => {
    for (const k of storeKeys) {
      const val = s.indices?.[k]?.changePct;
      if (val != null) return val;
    }
    return null;
  });
  const changePctRaw = useSymbolDataSelector(symbol, (d) => d.changePct);
  const changePct = changePctRaw ?? indexChange ?? fallback;
  const prevChange = useRef(changePct);
  const spanRef = useRef<HTMLSpanElement>(null);
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    if (changePct == null || changePct === prevChange.current || !spanRef.current) return;
    if (prevChange.current) {
      const el = spanRef.current;
      const isUp = changePct > prevChange.current;

      el.classList.remove('flash-up', 'flash-down');
      void el.offsetWidth; // Force reflow
      el.classList.add(isUp ? 'flash-up' : 'flash-down');

      if (flashTimeout.current) clearTimeout(flashTimeout.current);
      flashTimeout.current = setTimeout(() => {
        el.classList.remove('flash-up', 'flash-down');
      }, 600);
    }
    prevChange.current = changePct;
    return () => { if (flashTimeout.current) clearTimeout(flashTimeout.current); };
  }, [symbol, changePct]);
  
  const displayChange = changePct ?? fallback;

  const formattedChange = useMemo(() => {
    if (displayChange == null) return null;
    return fmtPct(displayChange, decimals);
  }, [displayChange, decimals]);

  // No data → reserve the line's height with an invisible placeholder instead
  // of rendering null: the % popping into existence on the first tick was
  // shifting sibling layout (price row nudged up/down). A blank keeps the
  // "no dash under a dash-price" intent without the jank.
  if (displayChange == null || formattedChange == null) {
    return <span className={cn("inline-block tabular-nums font-mono", className)} aria-hidden="true">{" "}</span>;
  }

  const isPositive = displayChange > 0;
  const isNegative = displayChange < 0;
  const baseColor = isPositive ? 'text-bull' : isNegative ? 'text-bear' : 'text-muted-foreground';
  return (
    <span ref={spanRef} className={cn("inline-block tabular-nums font-mono", baseColor, className)}>
      {formattedChange}
    </span>
  );
});
