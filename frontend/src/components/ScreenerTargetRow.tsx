import { motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/format";
import { LivePrice } from "@/components/atoms/LivePrice";
import { LiveChangePct } from "@/components/atoms/LiveChangePct";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchSymbol } from "@/lib/prefetch";
import { useStore } from "@/store/useStore";
import type { ScreenerTarget } from "@/hooks/useScreener";

interface ScreenerTargetRowProps {
  row: ScreenerTarget;
  title: string;
  selectedSymbol: string;
  onSelect: (symbol: string) => void;
  onDelete: (id: number) => Promise<void>;
}

function splitBadges(notes?: string | null) {
  if (!notes) return [];
  return notes.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 3);
}

export function ScreenerTargetRow({ row, title, selectedSymbol, onSelect, onDelete }: ScreenerTargetRowProps) {
  const queryClient = useQueryClient();
  const showIsland = useStore((s) => s.showIsland);

  const selected = selectedSymbol === row.symbol;
  const badges = splitBadges(row.notes);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      style={{ willChange: "transform, opacity" }}
      className={cn(
        "apple-hover flex h-[58px] items-center justify-between rounded-md px-3 py-1.5 w-full text-left transition-all relative overflow-hidden group border-0 font-mono shadow-none",
        selected
          ? "bg-secondary/50 text-foreground"
          : "bg-transparent hover:bg-secondary/20 text-foreground/85 hover:text-foreground"
      )}
    >
      <button
        role="option"
        aria-selected={selected}
        onClick={() => onSelect(row.symbol)}
        onPointerEnter={() => prefetchSymbol(queryClient, row.symbol)}
        className="absolute inset-0 z-0 cursor-pointer"
      />
      <div className="flex flex-col justify-center gap-1 min-w-0 flex-1 z-10 pointer-events-none">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-sm font-normal tracking-tight text-foreground">{row.symbol}</span>
          <span className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wider leading-none",
            row.notes ? "bg-primary/15 text-primary" : "bg-foreground/10 text-muted-foreground"
          )}>
            {row.notes ? "Rule" : "Manual"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {badges.map((badge) => (
            <span key={badge} className="text-[11px] font-normal uppercase tracking-wider text-accent truncate">
              {badge}
            </span>
          ))}
          {badges.length === 0 && (
            <span className="text-[11px] font-normal text-foreground/60 truncate">
              {row.notes ? "Matched condition" : "Added manually"}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 z-10 shrink-0">
        <div className="flex flex-col items-end pointer-events-none">
          <LivePrice
            symbol={row.symbol}
            decimals={2}
            className="text-sm font-normal tabular-nums font-mono leading-tight text-foreground"
          />
          <LiveChangePct
            symbol={row.symbol}
            decimals={2}
            className="text-[11px] font-normal tabular-nums font-mono leading-tight"
          />
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            showIsland({
              title: `Remove ${row.symbol}?`,
              subtitle: `This removes ${row.symbol} from "${title}". The stock itself is not deleted.`,
              isDestructive: true,
              confirmText: "Remove",
              cancelText: "Keep",
              onConfirm: async () => {
                await onDelete(row.id);
                return true;
              },
            });
          }}
          className={cn(
            "rounded-full p-1.5 opacity-0 transition-opacity group-hover:opacity-100 relative z-20",
            "text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
          )}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

    </motion.div>
  );
}
