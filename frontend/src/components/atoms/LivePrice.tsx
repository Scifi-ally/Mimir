import { memo, useEffect, useRef, useState, useMemo } from 'react';
import { useSymbolDataSelector, marketDataStore } from '@/providers/MarketDataProvider';
import { useStore } from '@/store/useStore';
import { cn, fmtNum } from '@/lib/format';

interface LivePriceProps {
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

export const LivePrice = memo(({ symbol, className, decimals = 2, fallback }: LivePriceProps) => {
  const storeKey = INDEX_MAP[symbol?.toUpperCase() || ""];
  const indexLtp = useStore((s) => storeKey ? s.indices?.[storeKey]?.ltp : null);
  const ltpRaw = useSymbolDataSelector(symbol, (d) => d.ltp);
  const ltp = ltpRaw ?? indexLtp;
  const prevLtp = useRef(ltp);
  const spanRef = useRef<HTMLSpanElement>(null);
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    if (ltp == null && fallback != null) {
      marketDataStore.updateFromRest(symbol, { ltp: fallback });
    }

    if (!ltp || ltp === prevLtp.current || !spanRef.current) return;
    if (prevLtp.current) {
      const el = spanRef.current;
      const isUp = ltp > prevLtp.current;
      
      el.classList.remove('flash-up', 'flash-down');
      void el.offsetWidth; // Force reflow
      el.classList.add(isUp ? 'flash-up' : 'flash-down');
      
      if (flashTimeout.current) clearTimeout(flashTimeout.current);
      flashTimeout.current = setTimeout(() => {
        el.classList.remove('flash-up', 'flash-down');
      }, 600);
      
      prevLtp.current = ltp;
      return () => { if (flashTimeout.current) clearTimeout(flashTimeout.current); };
    }
    prevLtp.current = ltp;
  }, [symbol, ltp, fallback]);

  const displayPrice = ltp ?? fallback;

  const formattedPrice = useMemo(() => {
    if (displayPrice == null) return null;
    return `₹${fmtNum(displayPrice, decimals)}`;
  }, [displayPrice, decimals]);

  if (displayPrice == null || formattedPrice == null) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }

  return (
    <span ref={spanRef} className={cn("inline-block tabular-nums font-mono", className)}>
      {formattedPrice}
    </span>
  );
});
