import { useState, useMemo, useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/format";
import { Card, CardHeader } from "@/components/mimir/card";
import { ScrollArea } from "@/components/mimir/scroll-area";
import type { StockRow } from "@/lib/watchlist";
import { buildStockRows } from "@/lib/watchlist";
import { useStore } from "@/store/useStore";
import { WatchlistCard } from "@/components/WatchlistCard";
import { LivePrice } from "@/components/atoms/LivePrice";
import { LiveChangePct } from "@/components/atoms/LiveChangePct";
import { Sparkline } from "@/components/Sparkline";
import type { WatchlistItem, MonitoredStock, Suggestion } from "@/types/api";

interface WatchlistStackProps {
  items: WatchlistItem[];
  monitored: MonitoredStock[] | undefined;
  suggestions: Suggestion[];
  selectedSymbol: string;
  sparklines?: Record<string, number[]>;
  onSelect: (symbol: string) => void;
}

export function WatchlistStack({ items, monitored, suggestions, selectedSymbol, sparklines, onSelect }: WatchlistStackProps) {
  const watchlistCounts = useStore((s) => s.watchlistCounts);
  
  const rows = useMemo(
    () => buildStockRows(items, monitored ?? [], suggestions, {}, sparklines),
    [items, monitored, suggestions, sparklines]
  );

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const mobileScrollRef = useRef<HTMLDivElement>(null);
  const [colWidth, setColWidth] = useState(160);
  const categories = countCategories(rows);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w === 0) continue;
        const gap = 8;
        const minW = 240;
        const numCols = Math.max(1, Math.floor((w + gap) / (minW + gap)));
        // Use exact width minus 0.1 to avoid subpixel overflow
        const exactWidth = Math.floor(((w - (numCols - 1) * gap) / numCols) * 10) / 10 - 0.1;
        setColWidth(exactWidth);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') || scrollRef.current;
    if (el) {
      if (e.deltaY !== 0 && e.deltaX === 0) {
        el.scrollLeft += e.deltaY;
      }
    }
  };

  const handleCategorySelect = (cat: string | null) => {
    setSelectedCategory(cat);
    
    let newFiltered = rows;
    if (cat) {
      newFiltered = rows.filter((r) => {
        const catName = r.category.replaceAll("_", " ").replace("WATCH", "").trim();
        return (catName || "Other").toLowerCase() === cat.toLowerCase();
      });
    }
    
    // Apply search filter
    if (searchText.trim()) {
      const query = searchText.toLowerCase();
      newFiltered = newFiltered.filter(
        (r) =>
          r.symbol.toLowerCase().includes(query) ||
          r.condition?.toLowerCase().includes(query) ||
          r.category.toLowerCase().includes(query)
      );
    }

    if (newFiltered.length > 0) {
      onSelect(newFiltered[0].symbol);
    }
  };

  useEffect(() => {
    if (selectedSymbol) {
      const el = document.getElementById(`watchlist-item-${selectedSymbol}`);
      if (el && scrollRef.current) {
        const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]') || scrollRef.current;
        if (viewport) {
          const elRect = el.getBoundingClientRect();
          const viewRect = viewport.getBoundingClientRect();
          
          if (elRect.left < viewRect.left || elRect.right > viewRect.right || elRect.top < viewRect.top || elRect.bottom > viewRect.bottom) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
          }
        }
      }
    }
  }, [selectedSymbol]);

  const filteredRows = useMemo(() => {
    let filtered = selectedCategory
      ? rows.filter((r) => {
          const catName = r.category.replaceAll("_", " ").replace("WATCH", "").trim();
          return (catName || "Other").toLowerCase() === selectedCategory.toLowerCase();
        })
      : rows;

    // Apply search filter
    if (searchText.trim()) {
      const query = searchText.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.symbol.toLowerCase().includes(query) ||
          r.condition?.toLowerCase().includes(query) ||
          r.category.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [rows, selectedCategory, searchText]);

  const columns = useMemo(() => {
    const cols = [];
    for (let i = 0; i < filteredRows.length; i += 3) {
      cols.push(filteredRows.slice(i, i + 3));
    }
    return cols;
  }, [filteredRows]);

  const virtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => {
      if (!scrollRef.current) return null;
      const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      return (viewport || scrollRef.current) as HTMLDivElement;
    },
    estimateSize: () => colWidth + 8,
    overscan: 3,
  });

  const mobileVirtualizer = useVirtualizer({
    horizontal: false,
    count: filteredRows.length,
    getScrollElement: () => {
      if (!mobileScrollRef.current) return null;
      const viewport = mobileScrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      return (viewport || mobileScrollRef.current) as HTMLDivElement;
    },
    estimateSize: () => 72,
    overscan: 5,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [colWidth, virtualizer]);

  useEffect(() => {
    if (selectedSymbol) {
      const index = filteredRows.findIndex(r => r.symbol === selectedSymbol);
      if (index !== -1) {
        const colIndex = Math.floor(index / 3);
        try {
          virtualizer.scrollToIndex(colIndex, { align: "auto" });
        } catch {
          // ignore scroll errors during render
        }
      }
    }
  }, [selectedSymbol, filteredRows, virtualizer]);

  return (
    <Card className="@container flex h-full min-h-0 flex-col border-0 bg-transparent">
      {rows.length > 0 && (
        <CardHeader className="shrink-0 px-2 py-1">
          <div className="flex flex-col gap-1">
            {/* Category Tabs */}
            <div className="flex overflow-x-auto whitespace-nowrap flex-nowrap gap-4 text-[10px] font-bold uppercase tracking-wider [&::-webkit-scrollbar]:hidden pb-1">
              <button
                type="button"
                onClick={() => handleCategorySelect(null)}
                className={cn(
                  "transition-all duration-300 relative group font-medium",
                  "@max-md:px-3 @max-md:py-1.5 @max-md:rounded-full",
                  selectedCategory === null 
                    ? "@max-md:bg-foreground @max-md:text-background @min-md:text-foreground @min-md:border-foreground"
                    : "@max-md:bg-secondary/40 @max-md:text-foreground/70 @min-md:text-foreground/50 @min-md:border-transparent hover:@min-md:text-foreground/80 hover:@min-md:border-foreground/40",
                  "@min-md:px-0 @min-md:py-0 @min-md:border-b-2 @min-md:pb-0.5"
                )}
              >
                All {watchlistCounts["ALL"] ?? rows.length}
                {selectedCategory !== null && (
                  <span className="hidden @min-md:block absolute inset-x-0 -bottom-0.5 h-0.5 bg-foreground/30 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                )}
              </button>
              {categories.map(([cat, n]) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => handleCategorySelect(cat)}
                  className={cn(
                    "transition-all duration-300 relative group font-medium",
                    "@max-md:px-3 @max-md:py-1.5 @max-md:rounded-full",
                    selectedCategory === cat
                      ? "@max-md:bg-foreground @max-md:text-background @min-md:text-foreground @min-md:border-foreground"
                      : "@max-md:bg-secondary/40 @max-md:text-foreground/70 @min-md:text-foreground/60 @min-md:border-transparent hover:@min-md:text-foreground/80 hover:@min-md:border-foreground/40",
                    "@min-md:px-0 @min-md:py-0 @min-md:border-b-2 @min-md:pb-0.5"
                  )}
                >
                  {cat} {watchlistCounts[cat] ?? n}
                  {selectedCategory !== cat && (
                    <span className="hidden @min-md:block absolute inset-x-0 -bottom-0.5 h-0.5 bg-foreground/30 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                  )}
                </button>
              ))}
            </div>


          </div>
        </CardHeader>
      )}

      {/* DESKTOP: Horizontal Virtualized Grid (Shown when container is wide) */}
      <ScrollArea 
        ref={scrollRef} 
        className="hidden @min-md:block flex-1 min-h-0 px-2 pb-2 snap-x snap-mandatory" 
        orientation="horizontal" 
        onWheel={handleWheel}
      >
        <AnimatePresence mode="wait">
          <motion.div 
            key={selectedCategory || "all"}
            initial={{ opacity: 0, filter: "blur(2px)", scale: 0.98 }}
            animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
            exit={{ opacity: 0, filter: "blur(2px)", scale: 0.98 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="relative pb-2" 
            style={{ width: `${virtualizer.getTotalSize()}px`, height: '100%', minHeight: '160px' }}
          >
          {filteredRows.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-foreground/70 font-mono w-full">
            </div>
          ) : (
            virtualizer.getVirtualItems().map((virtualItem) => {
              const colRows = columns[virtualItem.index]!;
              return (
                <div
                  key={virtualItem.key}
                  className="absolute top-0 left-0 h-full grid grid-rows-3 gap-2 snap-start scroll-mx-2"
                  style={{
                    width: `${colWidth}px`,
                    transform: `translateX(${virtualItem.start}px)`,
                  }}
                >
                  {colRows.map((row) => (
                    <WatchlistCard
                      key={row.symbol}
                      row={row as unknown as React.ComponentProps<typeof WatchlistCard>["row"]}
                      selected={selectedSymbol === row.symbol}
                      onSelect={onSelect}
                      sparkline={sparklines?.[row.symbol]}
                    />
                  ))}
                </div>
              );
            })
          )}
          </motion.div>
        </AnimatePresence>
      </ScrollArea>

      {/* MOBILE LIST (vertical) */}
      <ScrollArea ref={mobileScrollRef} className="block @min-md:hidden flex-1 min-h-0 px-2 pb-2">
        <div 
          className="relative w-full"
          style={{ height: `${mobileVirtualizer.getTotalSize()}px` }}
        >
          {filteredRows.length === 0 ? (
            <div className="flex items-center justify-center text-xs text-foreground/70 font-mono py-10 w-full">
              No symbols found
            </div>
          ) : (
            mobileVirtualizer.getVirtualItems().map((virtualItem) => {
              const row = filteredRows[virtualItem.index];
              const selected = selectedSymbol === row.symbol;
              return (
                <div
                  key={virtualItem.key}
                  className="absolute top-0 left-0 w-full"
                  style={{
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                    paddingBottom: '8px',
                  }}
                >
                  <button
                    id={`watchlist-item-mobile-${row.symbol}`}
                    onClick={() => onSelect(row.symbol)}
                    className={cn(
                      "flex items-center justify-between rounded-xl px-4 py-3 w-full h-full text-left transition-all relative overflow-hidden group border will-change-transform",
                      selected
                        ? "bg-foreground text-background border-foreground shadow-md"
                        : "bg-secondary/10 border-transparent text-foreground hover:bg-secondary/20"
                    )}
                  >
                    <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={cn("truncate font-bold text-[15px]", selected ? "text-background" : "text-foreground")}>{row.symbol}</span>
                        {row.activeSignalDirection && (
                          <span className={cn("h-2 w-2 rounded-full", row.activeSignalDirection === "BUY" ? "bg-bull" : "bg-bear")} />
                        )}
                      </div>
                    </div>
                    
                    <div className="flex flex-col items-end pl-3 z-10">
                      <LivePrice 
                        symbol={row.symbol} 
                        decimals={2}
                        fallback={row.price}
                        className={cn("text-[15px] font-bold tabular-nums font-mono leading-tight", selected ? "text-background" : "text-foreground")}
                      />
                      <LiveChangePct 
                        symbol={row.symbol} 
                        decimals={2}
                        fallback={row.changePct}
                        className={cn("text-xs font-bold tabular-nums font-mono leading-tight", selected ? "text-background/70" : "text-foreground/50")}
                      />
                    </div>

                    {sparklines?.[row.symbol] && (
                      <div className="absolute bottom-0 left-0 right-0 h-4 opacity-20 pointer-events-none z-0">
                        <Sparkline data={sparklines[row.symbol]} color={selected ? "currentColor" : undefined} />
                      </div>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </Card>
  );
}







function countCategories(rows: StockRow[]) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = r.category.replaceAll("_", " ").replace("WATCH", "").trim() || "Other";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].slice(0, 4);
}
