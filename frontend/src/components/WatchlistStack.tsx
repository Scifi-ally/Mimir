import { useState, useMemo, useRef, useEffect, memo } from "react";
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
import type { WatchlistItem, MonitoredStock, Suggestion } from "@/types/api";
import { SPRING_STANDARD } from "@/lib/motion";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface WatchlistStackProps {
  items: WatchlistItem[];
  monitored: MonitoredStock[] | undefined;
  suggestions: Suggestion[];
  selectedSymbol: string | null;
  sparklines?: Record<string, number[]>;
  onSelect: (symbol: string) => void;
  headerLeft?: React.ReactNode;
  customItems?: { symbol: string; createdAt: string }[];
}

export const WatchlistStack = memo(function WatchlistStack({ items, customItems, monitored, suggestions, selectedSymbol, sparklines, onSelect, headerLeft }: WatchlistStackProps) {
  const safeOnSelect = onSelect || (() => {});
  const watchlistCounts = useStore((s) => s.watchlistCounts);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const showIsland = useStore((s) => s.showIsland);
  const queryClient = useQueryClient();

  const removeSymbolMutation = useMutation({
    mutationFn: (symbol: string) => api.removeCustomWatchlist(symbol),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customWatchlist"] });
      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
    },
    onError: (err, symbol) => {
      // A failed remove previously did nothing visible — the row just stayed,
      // looking like the click was ignored.
      showIsland({ isNotification: true, title: `Couldn't remove ${symbol}`, subtitle: err instanceof Error ? err.message : "Remove failed", showSuccessOnly: false });
    }
  });

  const handleRemoveSymbol = (symbol: string) => {
    removeSymbolMutation.mutate(symbol);
  };

  const rows = useMemo(
    () => buildStockRows(items, customItems ?? [], monitored ?? [], suggestions, {}, sparklines),
    [items, customItems, monitored, suggestions, sparklines]
  );

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mobileScrollRef = useRef<HTMLDivElement>(null);
  const [colWidth, setColWidth] = useState(290);
  const categories = countCategories(rows);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let rafId: number;
    const observer = new ResizeObserver((entries) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        for (const entry of entries) {
          const w = entry.contentRect.width;
          if (w === 0) continue;
          const gap = 10;
          const minW = 290;
          const numCols = Math.max(1, Math.floor((w + gap) / (minW + gap)));
          const exactWidth = Math.floor(((w - (numCols - 1) * gap) / numCols) * 10) / 10 - 0.1;
          setColWidth(exactWidth);
        }
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, []);

  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cardEl = cardRef.current;
    if (!cardEl) return;

    const onWheelNative = (e: WheelEvent) => {
      const headerScrollEl = (e.target as HTMLElement)?.closest('.overflow-x-auto') as HTMLElement;
      if (headerScrollEl && headerScrollEl.scrollWidth > headerScrollEl.clientWidth) {
        if (e.deltaY !== 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
          e.preventDefault();
          headerScrollEl.scrollLeft += e.deltaY * 2;
          return;
        }
      }

      const el = (scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') || scrollRef.current) as HTMLElement;
      if (!el) return;

      if (e.deltaY !== 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        if (el.scrollWidth > el.clientWidth) {
          e.preventDefault();
        }
        el.scrollLeft += e.deltaY * 2;
      }
    };

    cardEl.addEventListener("wheel", onWheelNative, { passive: false });
    return () => cardEl.removeEventListener("wheel", onWheelNative);
  }, []);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') || scrollRef.current;
    if (el && e.deltaY !== 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY * 2;
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
    
    if (newFiltered.length > 0) {
      safeOnSelect(newFiltered[0].symbol);
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
    const filtered = selectedCategory
      ? rows.filter((r) => {
          const catName = r.category.replaceAll("_", " ").replace("WATCH", "").trim();
          return (catName || "Other").toLowerCase() === selectedCategory.toLowerCase();
        })
      : rows;

    return filtered;
  }, [rows, selectedCategory]);

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
    estimateSize: () => colWidth + 10,
    overscan: 4, // Smooth instant rendering
  });

  const mobileVirtualizer = useVirtualizer({
    horizontal: false,
    count: filteredRows.length,
    getScrollElement: () => {
      if (!mobileScrollRef.current) return null;
      const viewport = mobileScrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      return (viewport || mobileScrollRef.current) as HTMLDivElement;
    },
    estimateSize: () => 68,
    overscan: 4,
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
    <Card ref={cardRef} onWheel={handleWheel} className="@container flex h-full min-h-0 flex-col border-0 bg-transparent">
      <CardHeader className="shrink-0 h-[48px] px-3 py-0 space-y-0 flex flex-row items-center justify-between gap-4 overflow-hidden">
        {headerLeft}
        {rows.length > 0 ? (
          /* justify-end on an overflow-x container clips overflow off the
             unreachable left edge (labels rendered as "CANNED 48"). ml-auto on
             the first item right-aligns when there's room and degrades to a
             normal left-anchored scroll when there isn't. */
          <div className="flex overflow-x-auto whitespace-nowrap flex-nowrap gap-4 text-[10px] font-medium uppercase tracking-[0.08em] font-sans [&::-webkit-scrollbar]:hidden pb-1 w-full items-center">
            <button
              type="button"
              onClick={() => handleCategorySelect(null)}
              className={cn(
                "ml-auto shrink-0 transition-all duration-300 relative group font-semibold",
                "@max-md:px-3 @max-md:py-1.5 @max-md:rounded-full",
                selectedCategory === null 
                  ? "@max-md:bg-foreground @max-md:text-background @min-md:text-foreground @min-md:border-foreground"
                  : "@max-md:bg-secondary/40 @max-md:text-foreground/70 @min-md:text-foreground @min-md:border-transparent hover:@min-md:text-foreground/80 hover:@min-md:border-foreground/40",
                "@min-md:px-1 @min-md:py-1 @min-md:border-b-2"
              )}
            >
              All {watchlistCounts["ALL"] ?? rows.length}
              {selectedCategory !== null && (
                <span className="hidden @min-md:block absolute inset-x-0 -bottom-[2px] h-[2px] bg-foreground/30 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
              )}
            </button>
            {categories.map(([cat, n]) => (
              <button
                key={cat}
                type="button"
                onClick={() => handleCategorySelect(cat)}
                className={cn(
                  "shrink-0 transition-all duration-300 relative group font-semibold",
                  "@max-md:px-3 @max-md:py-1.5 @max-md:rounded-full",
                  selectedCategory === cat
                    ? "@max-md:bg-foreground @max-md:text-background @min-md:text-foreground @min-md:border-b-foreground"
                    : "@max-md:bg-secondary/40 @max-md:text-foreground/70 @min-md:text-foreground/60 @min-md:border-b-transparent hover:@min-md:text-foreground/80 hover:@min-md:border-b-foreground/40",
                  "@min-md:px-1 @min-md:py-1 @min-md:border-t-2 @min-md:border-t-transparent @min-md:border-b-2"
                )}
              >
                {cat} {watchlistCounts[cat] ?? n}
                {selectedCategory !== cat && (
                  <span className="hidden @min-md:block absolute inset-x-0 -bottom-[2px] h-[2px] bg-foreground/30 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                )}
              </button>
            ))}

            <button
              type="button"
              onClick={() => setCommandPaletteOpen(true, "", "CUSTOM")}
              className="shrink-0 ml-1 sm:ml-2 px-2 sm:px-3 py-1 rounded-md border-2 border-foreground bg-transparent text-foreground font-bold uppercase tracking-wider text-[9px] sm:text-[10px] transition-colors duration-200 hover:bg-foreground hover:text-background"
            >
              Add Symbol
            </button>
          </div>
        ) : (
          /* The empty list is exactly when Add Symbol matters most — keep it. */
          <div className="flex items-center justify-end gap-2 sm:gap-4 w-full text-[10px] font-normal uppercase tracking-[0.08em] text-muted-foreground/60 shrink overflow-hidden">
            <span className="hidden sm:inline">0 Symbols</span>
            <button
              type="button"
              onClick={() => setCommandPaletteOpen(true, "", "CUSTOM")}
              className="shrink-0 px-2 sm:px-3 py-1 rounded-md border-2 border-foreground bg-transparent text-foreground font-bold uppercase tracking-wider text-[9px] sm:text-[10px] transition-colors duration-200 hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            >
              Add Symbol
            </button>
          </div>
        )}
      </CardHeader>

      {filteredRows.length === 0 ? (
        <div className="flex-1 w-full h-full min-h-[180px] flex flex-col items-center justify-center text-center px-4 py-8 gap-4">
          <p className="text-xs sm:text-sm font-normal text-muted-foreground max-w-[80%] mx-auto leading-relaxed">
            No scan yet. Run the scanner or select from Screener.
          </p>
          <button
            type="button"
            onClick={() => setCommandPaletteOpen(true, "", "CUSTOM")}
            className="px-4 py-1.5 rounded-lg border border-foreground/30 text-xs text-foreground/80 hover:bg-foreground hover:text-background transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
          >
            Add a symbol manually
          </button>
        </div>
      ) : (
        <>
          {/* DESKTOP: Horizontal Virtualized Grid (Shown when container is wide) */}
          <ScrollArea 
            ref={scrollRef} 
            className="hidden @min-md:block flex-1 min-h-0 px-2 pb-2" 
            orientation="horizontal" 
            onWheel={handleWheel}
          >
            <AnimatePresence mode="wait">
              <motion.div 
                key={selectedCategory || "all"}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={SPRING_STANDARD}
                style={{ willChange: "transform, opacity", width: `${virtualizer.getTotalSize()}px`, height: '100%', minHeight: '160px' }}
              >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const colRows = columns[virtualItem.index] ?? [];
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
                          onSelect={safeOnSelect}
                          onRemove={handleRemoveSymbol}
                        />
                      ))}
                    </div>
                  );
                })}
              </motion.div>
            </AnimatePresence>
          </ScrollArea>

          {/* MOBILE LIST (vertical) */}
          <ScrollArea ref={mobileScrollRef} className="block @min-md:hidden flex-1 min-h-0 px-2 pb-2">
            <div 
              className="relative w-full"
              style={{ height: `${mobileVirtualizer.getTotalSize()}px` }}
            >
              {mobileVirtualizer.getVirtualItems().map((virtualItem) => {
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
                      onClick={() => safeOnSelect(row.symbol)}
                      className={cn(
                        "flex items-center justify-between rounded-xl px-4 py-3 w-full h-full text-left transition-all relative overflow-hidden group will-change-transform",
                        selected
                          ? "bg-foreground text-background"
                          : "bg-secondary/10 text-foreground hover:bg-secondary/20"
                      )}
                    >
                      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn("truncate font-normal text-[15px]", selected ? "text-background" : "text-foreground")}>{row.symbol}</span>
                          {row.activeSignalDirection && (
                            <span className={cn("h-2 w-2 rounded-full", row.activeSignalDirection === "BUY" ? "bg-bull" : "bg-bear")} />
                          )}
                          {row.category === "CUSTOM" && (
                            /* span, not button: a button nested inside the row
                               button is invalid HTML with undefined behavior for
                               keyboard/screen readers. */
                            <span
                              role="button"
                              tabIndex={0}
                              aria-label={`Remove ${row.symbol} from watchlist`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveSymbol(row.symbol);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleRemoveSymbol(row.symbol);
                                }
                              }}
                              className="text-muted-foreground hover:text-red-500 ml-2 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 rounded"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                            </span>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex flex-col items-end pl-3 z-10">
                        <LivePrice 
                          symbol={row.symbol} 
                          decimals={2}
                          fallback={row.price}
                          className={cn("text-[15px] font-normal tabular-nums font-mono leading-tight", selected ? "text-background" : "text-foreground")}
                        />
                        <LiveChangePct 
                          symbol={row.symbol} 
                          decimals={2}
                          fallback={row.changePct}
                          className={cn("text-xs font-normal tabular-nums font-mono leading-tight", selected ? "text-background/80" : "")}
                        />
                      </div>

                    </button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </>
      )}
    </Card>
  );
});







function countCategories(rows: StockRow[]) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = r.category.replaceAll("_", " ").replace("WATCH", "").trim() || "Other";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const sorted = [...m.entries()].sort((a, b) => {
    const aActive = a[0].toUpperCase().includes("ACTIVE");
    const bActive = b[0].toUpperCase().includes("ACTIVE");
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;

    const aMonitored = a[0].toUpperCase().includes("MONITORED");
    const bMonitored = b[0].toUpperCase().includes("MONITORED");
    if (aMonitored && !bMonitored) return -1;
    if (!aMonitored && bMonitored) return 1;

    return b[1] - a[1];
  });
  return sorted.slice(0, 6);
}


