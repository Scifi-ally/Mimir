import { memo, useEffect, useRef, useState } from 'react';
import { useSymbolData } from '@/providers/MarketDataProvider';

interface LiveVolumeProps {
  symbol: string;
  className?: string;
  fallback?: number | null;
}

export const LiveVolume = memo(({ symbol, className, fallback }: LiveVolumeProps) => {
  const { volume } = useSymbolData(symbol);
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

  // Format volume (e.g., 1.2M, 500K)
  const formatVolume = (vol: number) => {
    if (vol >= 1000000) return (vol / 1000000).toFixed(1) + 'M';
    if (vol >= 1000) return (vol / 1000).toFixed(1) + 'K';
    return vol.toString();
  };

  return (
    <span className={`${className} ${flash === 'up' ? 'text-green-500' : ''}`}>
      {volume != null ? formatVolume(volume) : (fallback ?? '—')}
    </span>
  );
});
LiveVolume.displayName = 'LiveVolume';
