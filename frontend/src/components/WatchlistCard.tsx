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
  let scoreBg = "bg-bear/15 text-bear";
  if (score > 65) scoreBg = "bg-bull/15 text-bull";
  else if (score >= 40) scoreBg = "bg-amber-500/15 text-amber-500";

  const topTag = row.signalTags && row.signalTags.length > 0 ? row.signalTags[0] : null;

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(row.symbol)}
      className={cn(
        "flex flex-col justify-center rounded-md px-3 py-1.5 text-left transition-all duration-200 relative overflow-hidden group border-0 h-[58px] w-full min-w-0 font-mono shadow-none",
        selected
          ? "bg-secondary/50 text-foreground"
          : "bg-transparent hover:bg-secondary/20 text-foreground/85 hover:text-foreground"
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
              className={cn("truncate text-sm font-bold tracking-tight transition-colors", selected ? "text-foreground" : "text-foreground group-hover:text-primary")}
            >
              {row.symbol}
            </span>
            {score > 0 && (
              <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-extrabold leading-none shrink-0", scoreBg)}>
                {Math.round(score)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            {topTag ? (
              <span className="truncate text-[11px] font-bold text-accent uppercase tracking-wider">
                {topTag}
              </span>
            ) : (
              <span className="truncate text-[11px] font-medium text-foreground/65 capitalize">
                {row.indicatorStatus || row.condition || "Monitored"}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end justify-center gap-0 flex-shrink-0 whitespace-nowrap z-10">
          <LivePrice 
            symbol={row.symbol} 
            decimals={2}
            fallback={row.price}
            className="text-sm font-bold tabular-nums font-mono leading-tight text-foreground"
          />
          <LiveChangePct
            symbol={row.symbol}
            decimals={2}
            fallback={row.changePct}
            className="text-[11px] font-bold tabular-nums font-mono leading-tight"
          />
        </div>
      </div>

      {sparkline && (
        <div className="absolute bottom-0 left-0 right-0 h-4 opacity-25 pointer-events-none z-0">
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
