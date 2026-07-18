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

const INDEX_MAP: Record<string, string> = {
  "NIFTY 50": "nifty",
  "SENSEX": "sensex",
  "BANK NIFTY": "banknifty",
  "BANKNIFTY": "banknifty",
  "FIN NIFTY": "finnifty",
  "FINNIFTY": "finnifty",
  "INDIA VIX": "vix",
};

export const LiveChangePct = memo(({ symbol, className, decimals = 2, fallback }: LiveChangePctProps) => {
  const storeKey = INDEX_MAP[symbol?.toUpperCase() || ""];
  const indexChange = useStore((s) => storeKey ? s.indices?.[storeKey]?.changePct : null);
  const changePctRaw = useSymbolDataSelector(symbol, (d) => d.change_pct);
  const changePct = changePctRaw ?? indexChange;
  const prevChange = useRef(changePct);
  const spanRef = useRef<HTMLSpanElement>(null);
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    if (!changePct || changePct === prevChange.current || !spanRef.current) return;
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
      
      prevChange.current = changePct;
      return () => { if (flashTimeout.current) clearTimeout(flashTimeout.current); };
    }
    prevChange.current = changePct;
  }, [symbol, changePct]);
  
  const displayChange = changePct ?? fallback;

  const formattedChange = useMemo(() => {
    if (displayChange == null) return null;
    return fmtPct(displayChange, decimals);
  }, [displayChange, decimals]);

  // No data → render nothing; a lone dash under a dash-price just doubles the noise
  if (displayChange == null || formattedChange == null) {
    return null;
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
