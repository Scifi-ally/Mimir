import { memo, useEffect, useRef, useMemo } from 'react';
import { useSymbolDataSelector } from '@/providers/MarketDataProvider';
import { useStore } from '@/store/useStore';
import { cn, fmtNum } from '@/lib/format';

interface LivePriceProps {
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

export const LivePrice = memo(({ symbol, className, decimals = 2, fallback }: LivePriceProps) => {
  const storeKeys = INDEX_MAP[symbol?.toUpperCase() || ""] || [];
  const indexLtp = useStore((s) => {
    for (const k of storeKeys) {
      const val = s.indices?.[k]?.ltp;
      if (val != null) return val;
    }
    return null;
  });
  const ltpRaw = useSymbolDataSelector(symbol, (d) => d.ltp);
  // Stale = a real feed price that hasn't ticked within the store's TTL (e.g. the
  // WebSocket dropped). Index prices come from a separate store with no staleness
  // signal, so only treat symbol-sourced prices as potentially stale.
  const isStale = useSymbolDataSelector(symbol, (d) => d.is_stale);
  const ltp = ltpRaw ?? indexLtp ?? fallback;
  const prevLtp = useRef(ltp);
  const spanRef = useRef<HTMLSpanElement>(null);
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
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
    }
    prevLtp.current = ltp;
    return () => { if (flashTimeout.current) clearTimeout(flashTimeout.current); };
  }, [symbol, ltp]);

  const displayPrice = ltp ?? fallback;

  const formattedPrice = useMemo(() => {
    if (displayPrice == null) return null;
    return `₹${fmtNum(displayPrice, decimals)}`;
  }, [displayPrice, decimals]);

  if (displayPrice == null || formattedPrice == null) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }

  const showStale = Boolean(isStale && ltpRaw != null);

  return (
    <span
      ref={spanRef}
      title={showStale ? "Price feed stale — last known value" : undefined}
      // A dashed underline is perceivable where opacity alone is not (small
      // text, screenshots, colour-blind users); aria-label makes staleness
      // reach screen readers, which title alone does not reliably do.
      aria-label={showStale ? `${formattedPrice} (stale — feed not updating)` : undefined}
      className={cn(
        "inline-block tabular-nums font-mono",
        showStale && "opacity-55 underline decoration-dashed decoration-1 underline-offset-4 decoration-foreground/40",
        className,
      )}
    >
      {formattedPrice}
    </span>
  );
});
