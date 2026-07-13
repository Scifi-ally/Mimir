import { memo, useEffect, useRef, useState } from 'react';
import { useSymbolDataSelector, marketDataStore } from '@/providers/MarketDataProvider';
import { cn, fmtNum } from '@/lib/format';

interface LivePriceProps {
  symbol: string;
  className?: string;
  decimals?: number;
  fallback?: number | null;
}

export const LivePrice = memo(({ symbol, className, decimals = 2, fallback }: LivePriceProps) => {
  const ltp = useSymbolDataSelector(symbol, (d) => d.ltp);
  const prevLtp = useRef(ltp);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  
  useEffect(() => {
    if (ltp == null && fallback != null) {
      marketDataStore.updateFromRest(symbol, { ltp: fallback });
    }

    if (!ltp || ltp === prevLtp.current) return;
    if (prevLtp.current) {
      setFlash(ltp > prevLtp.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 150);
      prevLtp.current = ltp;
      return () => clearTimeout(t);
    }
    prevLtp.current = ltp;
  }, [symbol, ltp, fallback]);
  
  const displayPrice = ltp ?? fallback;

  if (displayPrice == null) {
    return <span className={cn("text-muted-foreground", className)}>-</span>;
  }

  return (
    <span 
      className={cn(
        "transition-colors duration-75",
        flash === 'up' && "text-green-500",
        flash === 'down' && "text-red-500",
        className
      )}
    >
      ₹{fmtNum(displayPrice, decimals)}
    </span>
  );
});
