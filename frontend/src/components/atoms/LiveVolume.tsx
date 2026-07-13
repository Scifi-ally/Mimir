import { memo, useEffect, useRef, useState } from 'react';
import { useSymbolDataSelector } from '@/providers/MarketDataProvider';

interface LiveVolumeProps {
  symbol: string;
  className?: string;
  fallback?: number | null;
}

export const LiveVolume = memo(({ symbol, className, fallback }: LiveVolumeProps) => {
  const volume = useSymbolDataSelector(symbol, (d) => d.volume);
  const prevVolume = useRef(volume);
  const [flash, setFlash] = useState<'up' | null>(null);
  
  useEffect(() => {
    if (volume == null || volume === prevVolume.current) return;
    if (prevVolume.current != null && volume > prevVolume.current) {
      setFlash('up');
      const t = setTimeout(() => setFlash(null), 400);
      prevVolume.current = volume;
      return () => clearTimeout(t);
    }
    prevVolume.current = volume;
  }, [volume]);

  const displayVolume = volume ?? fallback;

  if (displayVolume == null) {
    return <span className={`text-muted-foreground ${className || ''}`}>-</span>;
  }

  // Format volume (e.g. 1.5M, 200K)
  const formatVol = (v: number) => {
    if (v >= 10000000) return (v / 10000000).toFixed(2) + 'Cr';
    if (v >= 100000) return (v / 100000).toFixed(2) + 'L';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
    return v.toString();
  };

  return (
    <span 
      className={`transition-colors duration-200 ${
        flash === 'up' ? 'text-blue-400' : 'text-foreground'
      } ${className || ''}`}
    >
      {formatVol(displayVolume)}
    </span>
  );
});
