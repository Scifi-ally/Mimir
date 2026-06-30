import { memo, useEffect, useRef, useState } from 'react';
import { useSymbolData } from '@/providers/MarketDataProvider';

interface LiveChangePctProps {
  symbol: string;
  className?: string;
  decimals?: number;
  fallback?: number | null;
}

export const LiveChangePct = memo(({ symbol, className, decimals = 2, fallback }: LiveChangePctProps) => {
  const { change_pct: changePct } = useSymbolData(symbol);
  const prevChange = useRef(changePct);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  
  useEffect(() => {
    if (changePct == null || changePct === prevChange.current) return;
    if (prevChange.current != null) {
      setFlash(changePct > prevChange.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 400);
      prevChange.current = changePct;
      return () => clearTimeout(t);
    }
    prevChange.current = changePct;
  }, [changePct]);
  
  const displayChange = changePct ?? fallback;
  const sign = (displayChange ?? 0) > 0 ? '+' : '';
  const color = (displayChange ?? 0) > 0 ? '#22C55E' : (displayChange ?? 0) < 0 ? '#EF4444' : 'inherit';

  return (
    <span 
      className={className}
      style={{ 
        color: flash ? (flash === 'up' ? '#22C55E' : '#EF4444') : color,
        transition: 'color 400ms ease-out'
      }}
    >
      {displayChange != null ? `${sign}${displayChange.toFixed(decimals)}%` : '—'}
    </span>
  );
});
LiveChangePct.displayName = 'LiveChangePct';
