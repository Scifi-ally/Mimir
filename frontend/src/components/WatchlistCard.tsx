import { memo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/format";
import type { StockRow } from "@/lib/watchlist";
import { LivePrice } from "@/components/atoms/LivePrice";
import { LiveChangePct } from "@/components/atoms/LiveChangePct";
import { prefetchSymbol } from "@/lib/prefetch";

interface WatchlistCardProps {
  row: StockRow;
  selected: boolean;
  onSelect: (symbol: string) => void;
}

export const WatchlistCard = memo(({ row, selected, onSelect }: WatchlistCardProps) => {
  const queryClient = useQueryClient();
  const score = row.compositeScore || 0;
  let scoreColor = "text-bear";
  if (score > 65) scoreColor = "text-bull";
  else if (score >= 40) scoreColor = "text-amber-500";

  const topTag = row.signalTags && row.signalTags.length > 0 ? row.signalTags[0] : null;
  // Strip scanner-internal prefixes like "REPEAT [100/100]:" — machine noise, not signal
  let statusText = (row.indicatorStatus || row.condition || "Monitored")
    .replace(/^(REPEAT|PERSISTENT)\s*\[\d+\/\d+\]:\s*/i, "");
  // Scanner boilerplate reads as noise in a 1-line row — collapse to short human labels
  if (/no qualified setup|candle data unavailable/i.test(statusText)) statusText = "Awaiting setup";
  else if (/^analyzing/i.test(statusText)) statusText = "Analyzing";
  else if (/^error|failed/i.test(statusText)) statusText = "Data unavailable";

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(row.symbol)}
      onPointerEnter={() => prefetchSymbol(queryClient, row.symbol)}
      className={cn(
        "flex flex-col justify-center rounded-lg px-3 py-1.5 text-left transition-colors duration-150 relative overflow-hidden group h-[56px] w-full min-w-0",
        selected
          ? "bg-foreground/[0.06] text-foreground"
          : "bg-transparent hover:bg-foreground/[0.03] text-foreground/85 hover:text-foreground"
      )}
    >
      <div className="grid grid-cols-[1fr_auto] gap-2.5 relative z-10 min-w-0 w-full h-full items-center">
        <div className="flex min-w-0 flex-col justify-center gap-0.5 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            {row.activeSignalDirection && (
              <span
                title={`Active ${row.activeSignalDirection} Signal`}
                className={cn(
                  "inline-block w-2 h-2 rounded-full shrink-0 animate-pulse",
                  row.activeSignalDirection === "BUY"
                    ? "bg-bull"
                    : "bg-bear"
                )}
              />
            )}
            <span 
              className={cn("truncate text-[13px] font-medium tracking-[-0.01em] transition-colors font-sans", selected ? "text-foreground" : "text-foreground group-hover:text-primary")}
            >
              {row.symbol}
            </span>
            {score > 0 && (
              <span className={cn("text-[10px] font-medium leading-none shrink-0 tabular-nums font-mono", scoreColor)}>
                {Math.round(score)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            {topTag ? (
              <span className="truncate text-[10px] font-normal text-foreground/40 uppercase tracking-[0.08em] font-sans">
                {topTag}
              </span>
            ) : (
              <span className="truncate text-[10px] font-normal text-foreground/40 capitalize font-sans">
                {statusText}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end justify-center gap-0 flex-shrink-0 whitespace-nowrap z-10">
          <LivePrice 
            symbol={row.symbol} 
            decimals={2}
            fallback={row.price}
            className="text-[13px] font-normal tabular-nums font-mono leading-tight text-foreground"
          />
          <LiveChangePct
            symbol={row.symbol}
            decimals={2}
            fallback={row.changePct}
            className="text-[10px] font-normal tabular-nums font-mono leading-tight"
          />
        </div>
      </div>

    </button>
  );
}, (prev, next) => {
  return prev.row === next.row &&
    prev.selected === next.selected;
});
WatchlistCard.displayName = "WatchlistCard";
