import { memo } from "react";
import { cn } from "@/lib/format";
import type { StockRow } from "@/lib/watchlist";
import { Sparkline } from "@/components/Sparkline";
import { LivePrice } from "@/components/atoms/LivePrice";
import { LiveChangePct } from "@/components/atoms/LiveChangePct";

interface WatchlistCardProps {
  row: StockRow;
  selected: boolean;
  onSelect: (symbol: string) => void;
  sparkline?: number[];
}

export const WatchlistCard = memo(({ row, selected, onSelect, sparkline }: WatchlistCardProps) => {
  const score = row.compositeScore || 0;
  let scoreColor = "text-bear font-mono";
  if (score > 65) scoreColor = "text-bull font-mono";
  else if (score >= 40) scoreColor = "text-amber-500 font-mono";

  const topTag = row.signalTags && row.signalTags.length > 0 ? row.signalTags[0] : null;

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(row.symbol)}
      className={cn(
        "flex flex-col justify-center rounded px-2.5 py-1.5 text-left transition-colors relative overflow-hidden group border h-[52px] w-full min-w-0 border-transparent font-mono",
        selected
          ? "bg-secondary/60 text-foreground"
          : "text-foreground/70 hover:bg-secondary/30 hover:text-foreground"
      )}
    >
      <div className="grid grid-cols-[1fr_auto] gap-1.5 relative z-10 min-w-0 w-full h-full items-center">
        <div className="flex min-w-0 flex-col gap-0.5 overflow-hidden">
          <div className="flex items-center gap-1.5 min-w-0">
            {row.activeSignalDirection && (
              <span
                title={`Active ${row.activeSignalDirection} Signal`}
                className={cn(
                  "inline-block w-2 h-2 rounded-full shrink-0 animate-pulse shadow-sm",
                  row.activeSignalDirection === "BUY"
                    ? "bg-bull shadow-bull/50"
                    : "bg-bear shadow-bear/50"
                )}
              />
            )}
            <span 
              className={cn("truncate text-xs font-bold transition-colors", selected ? "text-foreground" : "text-foreground/90")}
            >
              {row.symbol}
            </span>
            {score > 0 && (
              <span className={cn("text-[10px] font-bold leading-none", scoreColor)}>
                {Math.round(score)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 min-w-0 mt-0.5">
            {topTag ? (
              <span className="truncate text-[9px] font-semibold text-accent uppercase tracking-wider">
                {topTag}
              </span>
            ) : (
              <span className="truncate text-[9px] text-foreground/50 capitalize">
                {row.indicatorStatus}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-0 flex-shrink-0 whitespace-nowrap z-10">
          <LivePrice 
            symbol={row.symbol} 
            decimals={2}
            fallback={row.price}
            className={cn(
              "text-xs font-bold tabular-nums font-mono leading-tight transition-colors",
              selected ? "text-foreground" : "text-foreground/90 group-hover:text-foreground"
            )}
          />
          <LiveChangePct
            symbol={row.symbol}
            decimals={2}
            fallback={row.changePct}
            className={cn(
              "text-[9px] font-bold tabular-nums font-mono leading-tight transition-colors",
              selected ? "text-foreground/70" : "text-foreground/50 group-hover:text-foreground/80"
            )}
          />
        </div>
      </div>

      {sparkline && (
        <div className="absolute bottom-0 left-0 right-0 h-4 opacity-30 pointer-events-none z-0">
          <Sparkline 
            data={sparkline} 
            color={selected ? "hsl(var(--accent))" : "currentColor"}
          />
        </div>
      )}
    </button>
  );
}, (prev, next) => {
  return prev.row === next.row &&
    prev.selected === next.selected &&
    prev.sparkline === next.sparkline;
});
WatchlistCard.displayName = "WatchlistCard";
