import { memo, useEffect, useRef, useState } from 'react';
import { useSymbolDataSelector, marketDataStore } from '@/providers/MarketDataProvider';

interface LiveChangePctProps {
  symbol: string;
  className?: string;
  decimals?: number;
  fallback?: number | null;
}

export const LiveChangePct = memo(({ symbol, className, decimals = 2, fallback }: LiveChangePctProps) => {
  const changePct = useSymbolDataSelector(symbol, (d) => d.change_pct);
  const prevChange = useRef(changePct);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  
  useEffect(() => {
    if (changePct == null && fallback != null) {
      marketDataStore.updateFromRest(symbol, { change_pct: fallback });
    }

    if (changePct == null || changePct === prevChange.current) return;
    if (prevChange.current != null) {
      setFlash(changePct > prevChange.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 400);
      prevChange.current = changePct;
      return () => clearTimeout(t);
    }
    prevChange.current = changePct;
  }, [symbol, changePct, fallback]);
  
  const displayChange = changePct ?? fallback;

  if (displayChange == null) {
    return <span className={`text-muted-foreground ${className || ''}`}>-</span>;
  }

  const isPositive = displayChange > 0;
  const isNegative = displayChange < 0;
  
  return (
    <span 
      className={`transition-colors duration-200 ${
        flash === 'up' ? 'text-green-400' :
        flash === 'down' ? 'text-red-400' :
        isPositive ? 'text-green-500' :
        isNegative ? 'text-red-500' :
        'text-muted-foreground'
      } ${className || ''}`}
    >
      {isPositive ? '+' : ''}{displayChange.toFixed(decimals)}%
    </span>
  );
});
