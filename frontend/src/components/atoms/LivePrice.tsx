import { memo, useEffect, useRef, useState } from 'react';
import { useSymbolData } from '@/providers/MarketDataProvider';

interface LivePriceProps {
  symbol: string;
  className?: string;
  decimals?: number;
  fallback?: number | null;
}

export const LivePrice = memo(({ symbol, className, decimals = 2, fallback }: LivePriceProps) => {
  const { ltp } = useSymbolData(symbol);
  const prevLtp = useRef(ltp);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  
  useEffect(() => {
    if (!ltp || ltp === prevLtp.current) return;
    if (prevLtp.current) {
      setFlash(ltp > prevLtp.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 150);
      prevLtp.current = ltp;
      return () => clearTimeout(t);
    }
    prevLtp.current = ltp;
  }, [ltp]);
  
  const displayPrice = ltp ?? fallback;

  return (
    <span 
      className={className}
      style={{ 
        color: flash === 'up' ? '#22C55E' : flash === 'down' ? '#EF4444' : 'inherit',
        transition: flash ? 'none' : 'color 150ms ease-out'
      }}
    >
      {displayPrice != null ? displayPrice.toFixed(decimals) : '—'}
    </span>
  );
});
LivePrice.displayName = 'LivePrice';
