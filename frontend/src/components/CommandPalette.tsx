import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { useStore } from '@/store/useStore';
import { api } from '@/lib/api';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Plus, Filter, Loader2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AdvancedRuleBuilder } from './AdvancedRuleBuilder';
import type { SymbolSearchResult } from '@/types/api';
import { FADE_FAST, FADE_STANDARD } from "@/lib/motion";
import { Skeleton } from "@/components/atoms/Skeleton";

type ScreenerRule = {
  id: number;
  targetType: string;
  outputName?: string | null;
};

export function CommandPalette({ onClose, onWidthChange }: { onClose: () => void, onWidthChange?: (width: number) => void }) {
  const initialSearch = useStore((s) => s.commandPaletteSearch);
  const initialTargetWatchlist = useStore((s) => s.commandPaletteTargetWatchlist);
  const initialEditRuleId = useStore((s) => s.commandPaletteEditRuleId);
  const [search, setSearch] = useState(initialSearch || '');
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, symbol: string } | null>(null);
  const [targetWatchlist, setTargetWatchlist] = useState<number | null>(initialTargetWatchlist);
  
  // Rule builder state
  const [isBuildingRule, setIsBuildingRule] = useState(!!initialEditRuleId || (initialSearch ? initialSearch.toLowerCase().startsWith('scan ') : false));
  
  const queryClient = useQueryClient();
  const setSelectedSymbol = useStore((s) => s.setSelectedSymbol);
  const showIsland = useStore((s) => s.showIsland);

  const { data: screeners = [] } = useQuery<ScreenerRule[]>({
    queryKey: ["screener_rules"],
    queryFn: async () => {
      const res = await fetch("/api/screener");
      if (!res.ok) throw new Error("Failed to fetch screeners");
      return res.json();
    }
  });
  const customWatchlists = screeners.filter((s) => s.targetType === 'CUSTOM');
  const editRule = useMemo(() => {
    if (!initialEditRuleId) return undefined;
    return screeners.find(s => s.id === initialEditRuleId);
  }, [initialEditRuleId, screeners]);

  const batchSymbols = useMemo(() => {
    if (targetWatchlist === null || !search.includes(',')) return [];
    return Array.from(
      new Set(
        search
          .split(',')
          .map((symbol) => symbol.trim().toUpperCase())
          .filter(Boolean)
      )
    );
  }, [search, targetWatchlist]);

  const createTargetMutation = useMutation({
    mutationFn: async ({ symbol, screenerId }: { symbol: string, screenerId?: number }) => {
      const res = await fetch("/api/screener/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, screenerId })
      });
      if (!res.ok) throw new Error("Failed to add target");
      return res.json();
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["screener_targets"] });
      setContextMenu(null);
      showIsland({ title: `${vars.symbol} added`, showSuccessOnly: true, hideCancel: true });
    },
    onError: (err, vars) => {
      setContextMenu(null);
      showIsland({ isNotification: true, title: `Couldn't add ${vars.symbol}`, subtitle: err.message, showSuccessOnly: false });
    }
  });

  const createTargetsMutation = useMutation({
    mutationFn: async ({ symbols, screenerId }: { symbols: string[], screenerId: number }) => {
      return Promise.all(
        symbols.map(async (symbol) => {
          const res = await fetch("/api/screener/targets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbol, screenerId })
          });
          if (!res.ok) throw new Error(`Failed to add ${symbol}`);
          return res.json();
        })
      );
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["screener_targets"] });
      setContextMenu(null);
      showIsland({ title: `${vars.symbols.length} stock${vars.symbols.length === 1 ? "" : "s"} added`, showSuccessOnly: true, hideCancel: true });
    }
  });

  const handleClose = () => {
    onClose();
    // Delay resetting internal state until the unmount animation completely finishes
    setTimeout(() => {
      setSearch('');
      setIsBuildingRule(false);
      setTargetWatchlist(null);
    }, 400);
  };

  useEffect(() => {
    if (isBuildingRule) {
      onWidthChange?.(650);
    } else if (search.length === 0) {
      setIsBuildingRule(false);
      onWidthChange?.(480);
    }
  }, [isBuildingRule, search, onWidthChange]);

  useEffect(() => {
    setTargetWatchlist(initialTargetWatchlist);
  }, [initialTargetWatchlist]);

  const { data: searchResults, isPending, error } = useQuery({
    queryKey: ['searchSymbols', debouncedSearch],
    queryFn: () => api.searchSymbols(debouncedSearch, 40),
    enabled: debouncedSearch.length > 0 && batchSymbols.length === 0 && !debouncedSearch.toLowerCase().startsWith('scan') && !("scan".startsWith(debouncedSearch.toLowerCase())),
  });

  const handleSelectSymbol = (symbol: string) => {
    if (targetWatchlist !== null) {
      createTargetMutation.mutate({ symbol, screenerId: targetWatchlist });
      handleClose();
    } else {
      setSelectedSymbol(symbol);
      handleClose();
    }
  };

  const handleAddBatchSymbols = async () => {
    if (targetWatchlist === null || batchSymbols.length === 0) return;
    await createTargetsMutation.mutateAsync({ symbols: batchSymbols, screenerId: targetWatchlist });
    handleClose();
  };

  return (
    <>
      <AnimatePresence>
        {contextMenu && (
          <motion.div
            initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
            animate={{ opacity: 1, backdropFilter: 'blur(12px)' }}
            exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
            transition={FADE_STANDARD}
            style={{ top: contextMenu.y, left: contextMenu.x }}
            className="fixed z-[120] min-w-[200px] rounded-xl border border-border/20 bg-background/95 p-1.5 shadow-2xl backdrop-blur-md"
          >
            <div className="px-2 py-1.5 text-xs font-normal text-muted-foreground uppercase tracking-wider mb-1">
              {contextMenu.symbol}
            </div>
            <div className="px-2 py-1 text-xs text-foreground/70 mb-1">
              Add to:
            </div>
            {customWatchlists.length > 0 ? (
              customWatchlists.map((wl) => (
                <button
                  key={wl.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    createTargetMutation.mutate({ symbol: contextMenu.symbol, screenerId: wl.id });
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-foreground hover:bg-primary/20 hover:text-primary transition-colors text-left"
                >
                  <Plus className="h-4 w-4" />
                  {wl.outputName || "Unnamed Watchlist"}
                </button>
              ))
            ) : (
              <div className="px-2 py-1 text-xs text-foreground/50 italic">No custom watchlists</div>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setSearch('scan ');
                setIsBuildingRule(true);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-foreground hover:bg-primary/20 hover:text-primary transition-colors text-left"
            >
              <Filter className="h-4 w-4" />
              + Create New Watchlist
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <Command
        className="flex flex-col w-full bg-transparent"
        shouldFilter={false}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            handleClose();
          }
        }}
      >
          {!isBuildingRule ? (
            <div className="flex items-center px-4 py-3 relative">
              <Search className="mr-3 h-5 w-5 shrink-0 text-foreground/50" />
              <Command.Input
                id="command-palette-input"
                name="command-palette-input"
                aria-label="Search symbols"
                autoFocus
                placeholder={targetWatchlist !== null ? "Search or add comma-separated symbols..." : "Search symbols... (Try 'RELIANCE')"}
                value={search}
                onValueChange={setSearch}
                className="flex h-12 w-full bg-transparent text-lg font-normal text-foreground outline-none placeholder:text-foreground/30 placeholder:font-normal disabled:cursor-not-allowed disabled:opacity-50"
              />
              {batchSymbols.length > 0 && (
                <button
                  type="button"
                  onClick={handleAddBatchSymbols}
                  disabled={createTargetsMutation.isPending}
                  className="ml-3 flex shrink-0 items-center gap-1.5 rounded-full bg-foreground/10 px-4 py-1.5 text-xs font-normal text-foreground transition-colors hover:bg-foreground/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {createTargetsMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  {createTargetsMutation.isPending ? "Adding..." : "Add Stocks"}
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center px-4 pt-4 pb-1.5 text-center">
              <div className="flex items-center justify-center">
                <span className="text-xs font-normal tracking-tight text-foreground">Screener Rule Builder</span>
              </div>
            </div>
          )}

          {isBuildingRule ? (
            <motion.div
              layout
              key="rule-builder"
              initial={{ opacity: 0, scale: 0.98, filter: "blur(4px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0.98, filter: "blur(4px)" }}
              transition={FADE_FAST}
            >
              <AdvancedRuleBuilder initialRule={editRule} onComplete={() => {
                setIsBuildingRule(false);
                setSearch('');
              }} />
            </motion.div>
          ) : (
            <Command.List className={`overflow-y-auto overflow-x-hidden max-h-[400px] scrollbar-none ${searchResults?.items?.length ? 'p-2' : ''}`}>
              <Command.Empty className="hidden" />

              {isPending && search.length > 0 && (
                <div className="flex flex-col gap-1 p-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-lg">
                      <Skeleton className="h-7 w-7 rounded-md shrink-0" />
                      <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="h-2.5 w-40" />
                      </div>
                      <Skeleton className="h-3 w-12 shrink-0" />
                    </div>
                  ))}
                </div>
              )}

              {error && (
                <div className="py-4 text-center text-sm text-destructive px-2">
                  {error instanceof Error ? error.message : "Failed to search symbols"}
                </div>
              )}

              {createTargetsMutation.error && (
                <div className="py-4 text-center text-sm text-destructive px-2">
                  {createTargetsMutation.error instanceof Error ? createTargetsMutation.error.message : "Failed to add stocks"}
                </div>
              )}

              {batchSymbols.length > 0 && (
                <div className="px-4 pb-3 text-xs text-muted-foreground">
                  Ready to add {batchSymbols.length} symbol{batchSymbols.length === 1 ? "" : "s"}: {batchSymbols.join(", ")}
                </div>
              )}

              {!isPending && !error && batchSymbols.length === 0 && search.length > 0 && searchResults?.items?.length === 0 && (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  No symbols found for "{search}"
                </div>
              )}

              {searchResults?.items && searchResults.items.length > 0 && (
                <Command.Group heading="Symbols" className="px-2 pt-2 text-[10px] font-medium font-sans tracking-[0.12em] text-foreground/35 uppercase">
                  {searchResults.items.map((item: SymbolSearchResult) => {
                    return (
                      <Command.Item
                        key={item.symbol}
                        onSelect={() => handleSelectSymbol(item.symbol)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({ x: e.clientX, y: e.clientY, symbol: item.symbol });
                        }}
                        className="apple-hover flex cursor-pointer select-none items-center justify-between rounded-xl px-3 py-2.5 text-sm outline-none hover:bg-foreground/10 aria-selected:bg-foreground/10 aria-selected:text-foreground data-[selected=true]:bg-foreground/10 data-[selected=true]:text-foreground mt-1 transition-all duration-200"
                      >
                        <div className="flex flex-1 items-center gap-3 min-w-0 mr-3">
                          <span className="font-medium text-foreground font-mono tracking-tight shrink-0">{item.symbol}</span>
                          <span className="text-foreground/40 truncate text-xs font-sans">{item.name}</span>
                        </div>
                        {item.sector && (
                          <span className="text-[10px] uppercase tracking-[0.1em] font-medium font-sans text-foreground/25 shrink-0 rounded-full px-2 py-0.5 bg-foreground/5">{item.sector}</span>
                        )}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}
            </Command.List>
          )}
        </Command>
    </>
  );
}
