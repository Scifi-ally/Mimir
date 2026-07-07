import { memo, useEffect, useRef, useState } from 'react';
import { useSymbolData, marketDataStore } from '@/providers/MarketDataProvider';
import { fmtNum } from '@/lib/format';

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

  return (
    <span 
      className={className}
      style={{ 
        color: flash === 'up' ? '#22C55E' : flash === 'down' ? '#EF4444' : 'inherit',
        textShadow: flash === 'up' ? '0 0 12px rgba(34,197,94,0.6)' : flash === 'down' ? '0 0 12px rgba(239,68,68,0.6)' : 'none',
        transition: flash ? 'none' : 'all 300ms ease-out'
      }}
    >
      {fmtNum(displayPrice, decimals)}
    </span>
  );
});
LivePrice.displayName = 'LivePrice';
