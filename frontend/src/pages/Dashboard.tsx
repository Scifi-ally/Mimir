import { useEffect, useMemo, useState, startTransition, lazy, Suspense, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveGridLayout, useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { TopBar } from "@/components/TopBar";
import { PriceChart } from "@/components/PriceChart";
import { WatchlistStack } from "@/components/WatchlistStack";
import { ScreenerTargetsStack } from "@/components/ScreenerTargetsStack";
import { DetailPanel } from "@/components/DetailPanel";
import { StatusBar } from "@/components/StatusBar";
const SuggestionsSlider = lazy(() => import("@/components/SuggestionsSlider").then(m => ({ default: m.SuggestionsSlider })));
const PaperTradingPanel = lazy(() => import("@/components/PaperTradingPanel").then(m => ({ default: m.PaperTradingPanel })));
const ReportsLibrary = lazy(() => import("@/components/ReportsLibrary").then(m => ({ default: m.ReportsLibrary })));
import { useWebSocket, subscribeWsSymbols } from "@/hooks/useWebSocket";
import { useStore } from "@/store/useStore";
import { api } from "@/lib/api";

import type { WatchlistItem, Suggestion } from "@/types/api";

export default function Dashboard() {

  useWebSocket();

  const selectedSymbol = useStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useStore((s) => s.setSelectedSymbol);
  const wsConnected = useStore((s) => s.wsConnected);
  const scanState = useStore((s) => s.scanState);


  const [authorizing, setAuthorizing] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [chartMode, setChartMode] = useState<"actual" | "forecast">("actual");
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [isPaperTradingOpen, setIsPaperTradingOpen] = useState(false);
  const [isReportsOpen, setIsReportsOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"watchlist" | "screener">("watchlist");

  // react-grid-layout v2: measure container width via hook (replaces WidthProvider)
  const { width: gridWidth, mounted: gridMounted, containerRef: gridContainerRef } = useContainerWidth();

  const sessionQuery = useQuery({ queryKey: ["session"], queryFn: api.sessionState, refetchInterval: 60000 });
  const statusQuery = useQuery({ queryKey: ["status"], queryFn: api.systemStatus, refetchInterval: 10000 });
  const watchlistQuery = useQuery({ queryKey: ["watchlist"], queryFn: api.watchlistToday, refetchInterval: 30000 });
  const suggestionsQuery = useQuery<Suggestion[]>({ queryKey: ["suggestions"], queryFn: () => api.activeSuggestions(), refetchInterval: 10000 });
  const positionsQuery = useQuery({ queryKey: ["positions"], queryFn: () => api.paper.positions(), refetchInterval: 10000 });
  const indicesQuery = useQuery({ queryKey: ["indices"], queryFn: api.dashboardIndices, staleTime: Infinity });
  const regimeQuery = useQuery({ queryKey: ["regime"], queryFn: api.marketRegime, refetchInterval: 60000 });
  const monitoringQuery = useQuery({ queryKey: ["monitoring"], queryFn: api.intradayMonitoring, refetchInterval: 30000 });
  const indianContextQuery = useQuery({ queryKey: ["indian-context"], queryFn: api.indianContext, refetchInterval: 300000 });
  const scanning = scanState.scanning || Boolean(sessionQuery.data?.scanRunning);
  const scanLogs = useStore((s) => s.scanLogs);
  const activeSymbols = useMemo(() => {
    const symbols = new Set<string>();
    (suggestionsQuery.data ?? []).filter(s => s.status === "ACTIVE").forEach(s => symbols.add(s.symbol));
    (monitoringQuery.data?.monitoredStocks ?? []).forEach(s => symbols.add(s.symbol));
    return symbols;
  }, [suggestionsQuery.data, monitoringQuery.data]);

  const watchlistItems = useMemo(() => {
    if (scanning) {
      return scanLogs.map((log) => ({
        symbol: log.symbol,
        name: log.symbol,
        category: "SCANNED",
        condition: log.reason || log.status || "Live Scan Candidate",
        priority: 10,
      }));
    }
    const items = flattenWatchlist(watchlistQuery.data);
    return items.sort((a, b) => {
      const aActive = activeSymbols.has(a.symbol) ? 1 : 0;
      const bActive = activeSymbols.has(b.symbol) ? 1 : 0;
      return bActive - aActive;
    });
  }, [watchlistQuery.data, scanning, scanLogs, activeSymbols]);

  const watchlistSymbols = useMemo(() => {
    return watchlistItems.map(r => r.symbol);
  }, [watchlistItems]);

  const [debouncedSymbols, setDebouncedSymbols] = useState<string[]>(watchlistSymbols);

  const lastUpdateRef = useRef(0);
  const handlerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    // Use a throttle pattern so rapid updates don't completely stall the sparkline requests
    if (now - lastUpdateRef.current > 2000) {
      setDebouncedSymbols(watchlistSymbols);
      lastUpdateRef.current = now;
      if (handlerRef.current) clearTimeout(handlerRef.current);
    } else {
      if (handlerRef.current) clearTimeout(handlerRef.current);
      handlerRef.current = setTimeout(() => {
        setDebouncedSymbols(watchlistSymbols);
        lastUpdateRef.current = Date.now();
      }, 1500);
    }
    return () => {
      if (handlerRef.current) clearTimeout(handlerRef.current);
    };
  }, [watchlistSymbols]);

  const sparklinesQuery = useQuery({
    queryKey: ["sparklines", debouncedSymbols],
    queryFn: () => api.sparklines(debouncedSymbols),
    staleTime: 5 * 60 * 1000,
    enabled: debouncedSymbols.length > 0 && !scanning
  });

  const session = sessionQuery.data;
  const status = statusQuery.data;
  const suggestions = suggestionsQuery.data ?? [];
  const positions = positionsQuery.data ?? [];
  const regime = regimeQuery.data;
  const monitoring = monitoringQuery.data;
  const indianContext = indianContextQuery.data;

  const isIndex = ["NIFTY 50", "BANKNIFTY", "FINNIFTY", "INDIA VIX", "SENSEX"].includes(selectedSymbol);
  const activeSymbol = watchlistItems.length === 0 && !isIndex
    ? "NIFTY 50"
    : (selectedSymbol || watchlistItems[0]?.symbol || "");

  useEffect(() => {
    if (!selectedSymbol && watchlistItems.length > 0) {
      startTransition(() => setSelectedSymbol(watchlistItems[0]!.symbol));
    }
  }, [watchlistItems, selectedSymbol, setSelectedSymbol]);

  useEffect(() => {
    if (wsConnected && (watchlistSymbols.length > 0 || activeSymbols.size > 0)) {
      const combined = Array.from(new Set([...watchlistSymbols, ...Array.from(activeSymbols)]));
      subscribeWsSymbols(combined);
    }
  }, [watchlistSymbols, activeSymbols, wsConnected]);

  // Removed the stale selection clear block so users can keep custom command-palette selections even when the watchlist is empty.

  // Auto-select the first candidate found during a fresh live scan
  useEffect(() => {
    if (scanning && watchlistItems.length === 1 && watchlistItems[0]?.category === "SCANNED") {
      startTransition(() => setSelectedSymbol(watchlistItems[0].symbol));
    }
  }, [scanning, watchlistItems, setSelectedSymbol]);

  // Dynamic Favicon Logic
  useEffect(() => {
    document.title = "Mimir";
    const link: HTMLLinkElement = document.querySelector("link[rel~='icon']") || document.createElement("link");
    link.type = "image/svg+xml";
    link.rel = "icon";
    if (session?.isMarketOpen) {
      link.href = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%2322c55e"/></svg>';
    } else {
      link.href = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%23ef4444"/></svg>';
    }
    document.getElementsByTagName('head')[0].appendChild(link);
  }, [session]);

  const showIsland = useStore((s) => s.showIsland);

  // Global Keyboard Navigation
  useHotkeys("p", (e) => {
    e.preventDefault();
    startTransition(() => setIsSuggestionsOpen(prev => !prev));
  }, { preventDefault: true });

  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen);

  useHotkeys(["up", "down", "left", "right"], (e) => {
    if (commandPaletteOpen) return;
    e.preventDefault();
    if (watchlistItems.length === 0) return;
    const currentIndex = watchlistItems.findIndex((item) => item.symbol === activeSymbol);
    
    let newIndex: number;
    if (e.key === "ArrowDown") {
      newIndex = currentIndex < watchlistItems.length - 1 ? currentIndex + 1 : 0;
    } else if (e.key === "ArrowUp") {
      newIndex = currentIndex > 0 ? currentIndex - 1 : watchlistItems.length - 1;
    } else if (e.key === "ArrowRight") {
      newIndex = Math.min(currentIndex + 3, watchlistItems.length - 1);
    } else {
      newIndex = Math.max(currentIndex - 3, 0);
    }
    
    const newSymbol = watchlistItems[newIndex]?.symbol;
    if (newSymbol) startTransition(() => setSelectedSymbol(newSymbol));
  }, [watchlistItems, activeSymbol, setSelectedSymbol, commandPaletteOpen]);

  // Token Expiry Alert Logic
  useEffect(() => {
    if (status?.upstoxTokenExpiry) {
      const msLeft = status.upstoxTokenExpiry - Date.now();
      const fifteenMins = 15 * 60 * 1000;
      if (msLeft > 0 && msLeft < fifteenMins) {
        const mins = Math.ceil(msLeft / 60000);
        showIsland({ isNotification: true, title: "Upstox Session Expiring", subtitle: `⚠️ Upstox session expires in ${mins} minutes. Re-authorize soon!`, showSuccessOnly: false });
      }
    }
  }, [status?.upstoxTokenExpiry, showIsland]);


  // Trigger success tick if we just returned from Upstox auth
  useEffect(() => {
    const isPending = localStorage.getItem("upstox_auth_pending") === "true";
    if (isPending && status?.upstoxAuthenticated) {
      localStorage.removeItem("upstox_auth_pending");
      showIsland({
        title: "",
        subtitle: "",
        showSuccessOnly: true,
      });
    }
  }, [status?.upstoxAuthenticated, showIsland]);

  const authorizeUpstox = async () => {
    setAuthorizing(true);
    setAuthError(null);
    try {
      const data = await api.authUrl();
      if (data.alreadyAuthenticated) {
        setAuthorizing(false);
        showIsland({
          title: "",
          subtitle: "",
          showSuccessOnly: true,
        });
        return;
      }
      if (!data.url) throw new Error(data.error || "Authorization URL unavailable");
      
      localStorage.setItem("upstox_auth_pending", "true");
      window.location.assign(data.url);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authorization failed");
      setAuthorizing(false);
    }
  };

  const apiError = authError || sessionQuery.error?.message || watchlistQuery.error?.message || null;

  return (
    <div className="relative flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground font-sans">
      {/* Sci-Fi Vibrant Orbs Background */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute top-[-20%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-indigo-500/10 blur-[120px] mix-blend-screen animate-breathe" />
        <div className="absolute top-[20%] right-[-10%] w-[40vw] h-[40vw] rounded-full bg-emerald-500/10 blur-[120px] mix-blend-screen animate-breathe" style={{ animationDelay: '2s' }} />
        <div className="absolute bottom-[-20%] left-[20%] w-[60vw] h-[60vw] rounded-full bg-purple-500/5 blur-[120px] mix-blend-screen animate-breathe" style={{ animationDelay: '4s' }} />
      </div>
      
      <div className="z-10 flex h-full flex-col overflow-hidden">
        <motion.div
          initial={{ opacity: 0, y: -20, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ type: "spring", stiffness: 350, damping: 35, mass: 0.8, delay: 0.05 }}
        >
          <TopBar
            indices={indicesQuery.data ?? null}
            status={statusQuery.data}
            wsConnected={wsConnected}
            onAuthorize={authorizeUpstox}
            authorizing={authorizing}
            watchlistDate={undefined}
            activeSignals={activeSymbols.size}
            scanning={scanning}
            scanProgress={scanState.total > 0 ? (scanState.current / scanState.total) * 100 : undefined}
            onOpenSuggestions={() => startTransition(() => setIsSuggestionsOpen(true))}
            onOpenPaperTrading={() => startTransition(() => setIsPaperTradingOpen(true))}
            onOpenReports={() => startTransition(() => setIsReportsOpen(true))}
            onSelectSymbol={(s: string) => startTransition(() => setSelectedSymbol(s))}
          />
        </motion.div>

        <AnimatePresence>
          {apiError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="shrink-0 px-2 py-0.5 overflow-hidden"
            >
              <p className="text-xs font-medium text-destructive">{apiError}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="min-h-0 flex-1 overflow-hidden p-4 pt-2">
          <div ref={gridContainerRef} className="hidden lg:block w-full h-full relative">
            {gridMounted && <ResponsiveGridLayout
              className="layout h-full"
              width={gridWidth}
              layouts={{
                lg: [
                  { i: "chart", x: 0, y: 0, w: 8, h: 6 },
                  { i: "watchlist", x: 0, y: 6, w: 8, h: 4 },
                  { i: "detail", x: 8, y: 0, w: 4, h: 10 }
                ]
              }}
              breakpoints={{ lg: 1024, md: 768, sm: 640, xs: 480, xxs: 0 }}
              cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
              rowHeight={Math.max((window.innerHeight - 150) / 10, 50)}
              dragConfig={{ enabled: true, handle: ".drag-handle" }}
              resizeConfig={{ enabled: true, handles: ["se"] }}
              margin={[16, 16] as const}
            >
              <div key="chart" className="flex flex-col min-h-0 min-w-0 glass-panel rounded-2xl p-1 z-10">
                <div className="drag-handle h-2 w-full flex justify-center items-center cursor-move opacity-20 hover:opacity-100 transition-opacity"><div className="w-8 h-1 rounded-full bg-foreground" /></div>
                <PriceChart 
                  symbol={activeSymbol} 
                  chartMode={chartMode} 
                  onChartModeChange={(m) => startTransition(() => setChartMode(m))} 
                  isMarketOpen={session?.isMarketOpen} 
                  suggestion={suggestions.find(s => s.symbol === activeSymbol)} 
                  position={positions.find((p: import("@/types/api").PaperPosition) => p.symbol === activeSymbol && p.status === "OPEN")}
                  isAuthenticated={status?.upstoxAuthenticated}
                />
              </div>

              <div key="watchlist" className="flex flex-col min-h-0 min-w-0 z-10 glass-panel rounded-2xl overflow-hidden pt-1">
                <div className="drag-handle h-2 w-full flex justify-center items-center cursor-move opacity-20 hover:opacity-100 transition-opacity"><div className="w-8 h-1 rounded-full bg-foreground" /></div>
                <div className="flex-1 min-h-0 relative">
                  {sidebarTab === "watchlist" ? (
                    <WatchlistStack 
                      headerLeft={
                        <div className="flex items-center p-0.5 bg-foreground/5 rounded-full relative shrink-0">
                          <button onClick={() => setSidebarTab("watchlist")} className="relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-full text-background">
                            <motion.div layoutId="desktopTabIndicator" className="absolute inset-0 bg-foreground rounded-full" />
                            <span className="relative z-10">Watchlist</span>
                          </button>
                          <button onClick={() => setSidebarTab("screener")} className="relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-full text-muted-foreground hover:text-foreground">
                            <span className="relative z-10">Screener</span>
                          </button>
                        </div>
                      }
                      items={watchlistItems} 
                      monitored={monitoring?.monitoredStocks} 
                      suggestions={suggestions} 
                      selectedSymbol={activeSymbol} 
                      sparklines={sparklinesQuery.data}
                      onSelect={(s) => startTransition(() => setSelectedSymbol(s))} 
                    />
                  ) : (
                    <ScreenerTargetsStack 
                      headerLeft={
                        <div className="flex items-center p-0.5 bg-foreground/5 rounded-full relative shrink-0">
                          <button onClick={() => setSidebarTab("watchlist")} className="relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-full text-muted-foreground hover:text-foreground">
                            <span className="relative z-10">Watchlist</span>
                          </button>
                          <button onClick={() => setSidebarTab("screener")} className="relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-full text-background">
                            <motion.div layoutId="desktopTabIndicator" className="absolute inset-0 bg-foreground rounded-full" />
                            <span className="relative z-10">Screener</span>
                          </button>
                        </div>
                      }
                      selectedSymbol={activeSymbol} 
                      sparklines={sparklinesQuery.data} 
                      onSelect={(s) => startTransition(() => setSelectedSymbol(s))} 
                    />
                  )}
                </div>
              </div>

              <div key="detail" className="flex flex-col min-h-0 min-w-0 glass-panel rounded-2xl z-10 overflow-hidden pt-1">
                <div className="drag-handle h-2 w-full flex justify-center items-center cursor-move opacity-20 hover:opacity-100 transition-opacity"><div className="w-8 h-1 rounded-full bg-foreground" /></div>
                <DetailPanel
                  suggestions={suggestions}
                  selectedSymbol={activeSymbol}
                  session={session}
                />
              </div>
            </ResponsiveGridLayout>}
          </div>

          {/* Mobile Fallback */}
          <div className="flex lg:hidden flex-col gap-4 h-full overflow-y-auto">
            <div className="h-[500px]">
              <PriceChart 
                symbol={activeSymbol} 
                chartMode={chartMode} 
                onChartModeChange={(m) => startTransition(() => setChartMode(m))} 
                isMarketOpen={session?.isMarketOpen} 
                suggestion={suggestions.find(s => s.symbol === activeSymbol)} 
                position={positions.find((p: import("@/types/api").PaperPosition) => p.symbol === activeSymbol && (p as any).status === "OPEN")}
                isAuthenticated={status?.upstoxAuthenticated} 
              />
            </div>
            <div className="h-[400px] flex flex-col">
              <div className="flex-1 min-h-0 relative">
                {sidebarTab === "watchlist" ? (
                  <WatchlistStack 
                    headerLeft={
                      <div className="flex items-center p-0.5 bg-foreground/5 rounded-full relative shrink-0 mr-4">
                        <button
                          type="button"
                          onClick={() => setSidebarTab("watchlist")}
                          className="relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-full transition-colors text-background"
                        >
                          <motion.div layoutId="mobileTabIndicator" className="absolute inset-0 bg-foreground rounded-full" transition={{ type: "spring", bounce: 0.2, duration: 0.6 }} />
                          <span className="relative z-10">Watchlist</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setSidebarTab("screener")}
                          className="relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-full transition-colors text-muted-foreground hover:text-foreground"
                        >
                          <span className="relative z-10">Screener</span>
                        </button>
                      </div>
                    }
                    items={watchlistItems} monitored={monitoring?.monitoredStocks} suggestions={suggestions} selectedSymbol={activeSymbol} sparklines={sparklinesQuery.data} onSelect={(s) => startTransition(() => setSelectedSymbol(s))} 
                  />
                ) : (
                  <ScreenerTargetsStack 
                    headerLeft={
                      <div className="flex items-center p-0.5 bg-foreground/5 rounded-full relative shrink-0 mr-4">
                        <button
                          type="button"
                          onClick={() => setSidebarTab("watchlist")}
                          className="relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-full transition-colors text-muted-foreground hover:text-foreground"
                        >
                          <span className="relative z-10">Watchlist</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setSidebarTab("screener")}
                          className="relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-full transition-colors text-background"
                        >
                          <motion.div layoutId="mobileTabIndicator" className="absolute inset-0 bg-foreground rounded-full" transition={{ type: "spring", bounce: 0.2, duration: 0.6 }} />
                          <span className="relative z-10">Screener</span>
                        </button>
                      </div>
                    }
                    selectedSymbol={activeSymbol} sparklines={sparklinesQuery.data} onSelect={(s) => startTransition(() => setSelectedSymbol(s))} 
                  />
                )}
              </div>
            </div>
            <div className="h-[400px]">
              <DetailPanel suggestions={suggestions} selectedSymbol={activeSymbol} session={session} />
            </div>
          </div>
        </div>
        
        <StatusBar
          status={status}
          regime={regime}
          wsConnected={wsConnected}
          macro={indianContext}
        />
      </div>
      
      <Suspense fallback={null}>
        <SuggestionsSlider isOpen={isSuggestionsOpen} onClose={() => startTransition(() => setIsSuggestionsOpen(false))} onSelectSymbol={(s) => startTransition(() => setSelectedSymbol(s))} activeSuggestions={suggestions} />
      </Suspense>
      <Suspense fallback={null}>
        <PaperTradingPanel isOpen={isPaperTradingOpen} onClose={() => startTransition(() => setIsPaperTradingOpen(false))} />
      </Suspense>
      <Suspense fallback={null}>
        <ReportsLibrary isOpen={isReportsOpen} onClose={() => startTransition(() => setIsReportsOpen(false))} />
      </Suspense>
    </div>
    );
  }

function flattenWatchlist(watchlist: Awaited<ReturnType<typeof api.watchlistToday>> | undefined): WatchlistItem[] {
  if (!watchlist) return [];
  const merged = [
    ...watchlist.intradayCandidates,
    ...watchlist.breakoutCandidates,
    ...watchlist.momentumCandidates,
    ...watchlist.gapCandidates,
  ];
  const seen = new Set<string>();
  return merged.filter((item) => {
    if (seen.has(item.symbol)) return false;
    seen.add(item.symbol);
    return true;
  });
}
