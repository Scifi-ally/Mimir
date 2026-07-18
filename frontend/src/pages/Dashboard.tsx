import { useCallback, useEffect, useMemo, useState, lazy, Suspense, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useHotkeys } from "react-hotkeys-hook";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TopBar } from "@/components/TopBar";
import { PriceChart } from "@/components/PriceChart";
import { WatchlistStack } from "@/components/WatchlistStack";
import { ScreenerTargetsStack } from "@/components/ScreenerTargetsStack";
import { DetailPanel } from "@/components/DetailPanel";
import { ScanClockPanel } from "@/components/ScanClockPanel";
import { StatusBar } from "@/components/StatusBar";

const SuggestionsSlider = lazy(() => import("@/components/SuggestionsSlider").then(m => ({ default: m.SuggestionsSlider })));
const PaperTradingPanel = lazy(() => import("@/components/PaperTradingPanel").then(m => ({ default: m.PaperTradingPanel })));
const ReportsLibrary = lazy(() => import("@/components/ReportsLibrary").then(m => ({ default: m.ReportsLibrary })));
const SettingsDialog = lazy(() => import("@/components/SettingsDialog").then(m => ({ default: m.SettingsDialog })));

import { useWebSocket, subscribeWsSymbols } from "@/hooks/useWebSocket";
import { useStore } from "@/store/useStore";
import { api } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import { marketDataStore } from "@/providers/MarketDataProvider";

import type { WatchlistItem, Suggestion } from "@/types/api";
import { FADE_FAST, FADE_STANDARD, SPRING_GENTLE, SPRING_SNAPPY } from "@/lib/motion";

export default function Dashboard() {

  useWebSocket();
  const queryClient = useQueryClient();

  const selectedSymbol = useStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useStore((s) => s.setSelectedSymbol);
  const wsConnected = useStore((s) => s.wsConnected);
  // Shallow-select only the rendered fields — setScanState churns updatedAt/message on
  // every status message, which would otherwise re-render the whole dashboard.
  const scanState = useStore(useShallow((s) => ({ scanning: s.scanState.scanning, current: s.scanState.current, total: s.scanState.total })));
  const setScanState = useStore((s) => s.setScanState);

  const sessionQuery = useQuery({ queryKey: ["session"], queryFn: api.sessionState, refetchInterval: scanState.scanning ? 10000 : 60000, staleTime: 30000, placeholderData: (prev) => prev });

  useEffect(() => {
    if (sessionQuery.data && !sessionQuery.data.scanRunning && scanState.scanning) {
      setScanState({ scanning: false, phase: "completed", current: 0, total: 0 });
    }
  }, [sessionQuery.data?.scanRunning, scanState.scanning, setScanState]);

  const [authorizing, setAuthorizing] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [chartMode, setChartMode] = useState<"actual" | "forecast">("actual");
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [isPaperTradingOpen, setIsPaperTradingOpen] = useState(false);
  const [isReportsOpen, setIsReportsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"watchlist" | "screener">("watchlist");
  const statusQuery = useQuery({ queryKey: ["status"], queryFn: api.systemStatus, refetchInterval: 30000, staleTime: 25000, placeholderData: (prev) => prev });
  const watchlistQuery = useQuery({
    queryKey: ["watchlist"],
    queryFn: api.watchlistToday,
    refetchInterval: 120000,
    staleTime: 110000,
    gcTime: 300000,
    placeholderData: (previousData) => previousData,
  });
  const suggestionsQuery = useQuery<Suggestion[]>({ queryKey: ["suggestions"], queryFn: () => api.activeSuggestions(), refetchInterval: 30000, staleTime: 25000, placeholderData: (prev) => prev });
  const positionsQuery = useQuery({ queryKey: ["positions"], queryFn: () => api.paper.positions(), refetchInterval: 30000, staleTime: 25000, placeholderData: (prev) => prev });
  const indicesQuery = useQuery({ queryKey: ["indices"], queryFn: api.dashboardIndices, staleTime: Infinity, placeholderData: (prev) => prev });
  const regimeQuery = useQuery({ queryKey: ["regime"], queryFn: api.marketRegime, refetchInterval: 120000, staleTime: 110000, placeholderData: (prev) => prev });
  const monitoringQuery = useQuery({ queryKey: ["monitoring"], queryFn: api.intradayMonitoring, refetchInterval: 60000, staleTime: 55000, placeholderData: (prev) => prev });
  const indianContextQuery = useQuery({ queryKey: ["indian-context"], queryFn: api.indianContext, refetchInterval: 300000, staleTime: 290000, placeholderData: (prev) => prev });
  const scanning = scanState.scanning || Boolean(sessionQuery.data?.scanRunning);
  const isScanActive = scanning;
  const scanLogs = useStore((s) => s.scanLogs);
  const activeSymbols = useMemo(() => {
    const symbols = new Set<string>();
    (suggestionsQuery.data ?? []).filter(s => s.status === "ACTIVE" || s.status === "PENDING").forEach(s => symbols.add(s.symbol));
    (monitoringQuery.data?.monitoredStocks ?? []).forEach(s => symbols.add(s.symbol));
    return symbols;
  }, [suggestionsQuery.data, monitoringQuery.data]);

  const watchlistItems = useMemo(() => {
    const items = [...flattenWatchlist(watchlistQuery.data)];
    const existingSymbols = new Set(items.map(i => i.symbol));

    if (scanLogs && scanLogs.length > 0) {
      scanLogs.forEach((log) => {
        if (!existingSymbols.has(log.symbol)) {
          items.push({
            symbol: log.symbol,
            name: log.symbol,
            category: "SCANNED",
            condition: log.reason || log.status || "Live Scan Candidate",
            priority: 15,
          });
          existingSymbols.add(log.symbol);
        }
      });
    }

    // Ensure any active trade suggestions or monitored stocks appear directly inside Watchlist
    (suggestionsQuery.data ?? []).filter(s => s.status === "ACTIVE" || s.status === "PENDING").forEach(s => {
      if (!existingSymbols.has(s.symbol)) {
        items.unshift({
          symbol: s.symbol,
          name: s.symbol,
          category: "ACTIVE SIGNALS",
          condition: `Active ${s.direction} Signal @ ₹${fmtNum(s.entryPrice, 2)}`,
          priority: 100,
        });
        existingSymbols.add(s.symbol);
      } else {
        const idx = items.findIndex(i => i.symbol === s.symbol);
        if (idx !== -1) {
          items[idx] = {
            ...items[idx],
            category: "ACTIVE SIGNALS",
            condition: `Active ${s.direction} Signal @ ₹${fmtNum(s.entryPrice, 2)}`,
            priority: 100,
          };
        }
      }
    });

    // Removed monitored intraday stocks from watchlist as requested

    return items.sort((a, b) => {
      const aActive = activeSymbols.has(a.symbol) ? 1 : 0;
      const bActive = activeSymbols.has(b.symbol) ? 1 : 0;
      return bActive - aActive || (b.priority ?? 0) - (a.priority ?? 0) || a.symbol.localeCompare(b.symbol);
    });
  }, [watchlistQuery.data, scanning, scanLogs, activeSymbols, suggestionsQuery.data, monitoringQuery.data]);

  const watchlistSymbolsKey = useMemo(() => watchlistItems.map(r => r.symbol).join(","), [watchlistItems]);
  const watchlistSymbols = useMemo(() => (watchlistSymbolsKey ? watchlistSymbolsKey.split(",") : []), [watchlistSymbolsKey]);

  const [debouncedSymbols, setDebouncedSymbols] = useState<string[]>(watchlistSymbols);

  const lastUpdateRef = useRef(0);
  const handlerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    // Fast throttle for snappy initial load
    if (now - lastUpdateRef.current > 300) {
      setDebouncedSymbols(watchlistSymbols);
      lastUpdateRef.current = now;
      if (handlerRef.current) clearTimeout(handlerRef.current);
    } else {
      if (handlerRef.current) clearTimeout(handlerRef.current);
      handlerRef.current = setTimeout(() => {
        setDebouncedSymbols(watchlistSymbols);
        lastUpdateRef.current = Date.now();
      }, 300);
    }
    return () => {
      if (handlerRef.current) clearTimeout(handlerRef.current);
    };
  }, [watchlistSymbols]);

  const sparklinesQuery = useQuery({
    queryKey: ["sparklines", debouncedSymbols],
    queryFn: () => api.sparklines(debouncedSymbols),
    staleTime: 3 * 60 * 1000, // Reduced from 5min to 3min for fresher data
    gcTime: 5 * 60 * 1000,
    placeholderData: (previousData) => previousData, // Keep old sparklines while fetching
  });

  const mergeIndices = useStore((s) => s.mergeIndices);

  useEffect(() => {
    if (indicesQuery.data) {
      mergeIndices({
        nifty: { ltp: indicesQuery.data.nifty50?.ltp ?? null, changePct: indicesQuery.data.nifty50?.changePct ?? null },
        sensex: { ltp: indicesQuery.data.sensex?.ltp ?? null, changePct: indicesQuery.data.sensex?.changePct ?? null },
        banknifty: { ltp: indicesQuery.data.bankNifty?.ltp ?? null, changePct: indicesQuery.data.bankNifty?.changePct ?? null },
        finnifty: { ltp: indicesQuery.data.finnifty?.ltp ?? null, changePct: indicesQuery.data.finnifty?.changePct ?? null },
        vix: { ltp: indicesQuery.data.indiaVix?.ltp ?? null, changePct: indicesQuery.data.indiaVix?.changePct ?? null },
      });
      if (indicesQuery.data.nifty50?.ltp != null) marketDataStore.updateFromRest("NIFTY 50", { ltp: indicesQuery.data.nifty50.ltp, change_pct: indicesQuery.data.nifty50.changePct });
      if (indicesQuery.data.sensex?.ltp != null) marketDataStore.updateFromRest("SENSEX", { ltp: indicesQuery.data.sensex.ltp, change_pct: indicesQuery.data.sensex.changePct });
      if (indicesQuery.data.bankNifty?.ltp != null) marketDataStore.updateFromRest("BANK NIFTY", { ltp: indicesQuery.data.bankNifty.ltp, change_pct: indicesQuery.data.bankNifty.changePct });
      if (indicesQuery.data.finnifty?.ltp != null) marketDataStore.updateFromRest("FIN NIFTY", { ltp: indicesQuery.data.finnifty.ltp, change_pct: indicesQuery.data.finnifty.changePct });
      if (indicesQuery.data.indiaVix?.ltp != null) marketDataStore.updateFromRest("INDIA VIX", { ltp: indicesQuery.data.indiaVix.ltp, change_pct: indicesQuery.data.indiaVix.changePct });
    }
  }, [indicesQuery.data, mergeIndices]);

  const session = sessionQuery.data;
  const status = statusQuery.data;
  const suggestions = suggestionsQuery.data ?? [];
  const hasNoStocks = watchlistItems.length === 0 && suggestions.length === 0 && activeSymbols.size === 0;
  const showClock = isScanActive || hasNoStocks;
  const positions = positionsQuery.data ?? [];
  const regime = regimeQuery.data;
  const monitoring = monitoringQuery.data;
  // Null fields render "N/A" — never show fabricated macro numbers as real
  const indianContext = indianContextQuery.data ?? { fiiDii: null, niftyOptionChain: null };

  const isIndex = ["NIFTY 50", "BANKNIFTY", "FINNIFTY", "INDIA VIX", "SENSEX"].includes(selectedSymbol);
  const isSelectedValid = isIndex || watchlistItems.some(i => i.symbol === selectedSymbol) || activeSymbols.has(selectedSymbol);
  const activeSymbol = isSelectedValid
    ? selectedSymbol
    : (watchlistItems[0]?.symbol || "NIFTY 50");

  const watchlistMetadata = useMemo(() => {
    if (!watchlistQuery.data) return undefined;
    const data = watchlistQuery.data as { forDate: string; isFallback?: boolean; hasScan?: boolean };
    return {
      forDate: data.forDate,
      isFallback: Boolean(data.isFallback),
      hasScan: Boolean(data.hasScan ?? (watchlistItems.length > 0)),
    };
  }, [watchlistQuery.data, watchlistItems.length]);

  useEffect(() => {
    if ((!selectedSymbol || !isSelectedValid) && watchlistItems.length > 0) {
      setSelectedSymbol(watchlistItems[0]!.symbol);
    } else if (!isSelectedValid && watchlistItems.length === 0 && selectedSymbol !== "NIFTY 50") {
      setSelectedSymbol("NIFTY 50");
    }
  }, [watchlistItems, selectedSymbol, isSelectedValid, setSelectedSymbol]);

  useEffect(() => {
    if (watchlistSymbols.length > 0 || activeSymbols.size > 0) {
      const combined = Array.from(new Set([...watchlistSymbols, ...Array.from(activeSymbols)]));
      subscribeWsSymbols(combined);
    }
  }, [watchlistSymbols, activeSymbols, wsConnected]);

  // Removed the stale selection clear block so users can keep custom command-palette selections even when the watchlist is empty.

  // Auto-select the first candidate found during or at the end of a live scan
  const prevScanActiveRef = useRef(false);
  useEffect(() => {
    if (scanning && watchlistItems.length === 1 && watchlistItems[0]?.category === "SCANNED") {
      setSelectedSymbol(watchlistItems[0].symbol);
    }
    if (prevScanActiveRef.current && !isScanActive) {
      // Instantly fetch fresh watchlist data (and prices) when scan completes or stops
      void queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      
      // Clear scan logs when scan ends
      useStore.getState().setScanLogs([]);
      
      if (watchlistItems.length > 0 && !watchlistItems.find(r => r.symbol === selectedSymbol)) {
        setSelectedSymbol(watchlistItems[0].symbol);
      }
    }
    prevScanActiveRef.current = isScanActive;
  }, [scanning, isScanActive, watchlistItems, selectedSymbol, setSelectedSymbol, queryClient]);


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
    setIsSuggestionsOpen(prev => !prev);
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
    if (newSymbol) setSelectedSymbol(newSymbol);
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

  // Stable handlers so memo()'d TopBar doesn't re-render on every query refetch
  const openSuggestions = useCallback(() => setIsSuggestionsOpen(true), []);
  const openPaperTrading = useCallback(() => setIsPaperTradingOpen(true), []);
  const openReports = useCallback(() => setIsReportsOpen(true), []);
  const openSettings = useCallback(() => setIsSettingsOpen(true), []);
  const openEventFeed = useCallback(() => useStore.getState().setEventFeedOpen(true), []);

  const authorizeUpstox = useCallback(async (type: "trading" | "data" = "trading") => {
    setAuthorizing(true);
    setAuthError(null);
    try {
      const data = await api.authUrl(type);
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
  }, [showIsland]);

  const apiError = authError || sessionQuery.error?.message || watchlistQuery.error?.message || null;

  // Memoized tab-switcher headers (keyed only on sidebarTab; setSidebarTab is a stable
  // setter) so memo()'d WatchlistStack isn't re-rendered by unrelated query refetches.
  const desktopTabHeader = useMemo(() => (
    <div className="flex items-center p-0.5 bg-foreground/5 rounded-full relative shrink-0 h-8">
      <button
        type="button"
        onClick={() => setSidebarTab("watchlist")}
        className={`relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-full transition-colors ${sidebarTab === "watchlist" ? "text-background" : "text-muted-foreground hover:text-foreground"}`}
      >
        {sidebarTab === "watchlist" && <motion.div layoutId="desktopTabIndicator" className="absolute inset-0 bg-foreground rounded-full" transition={SPRING_SNAPPY} />}
        <span className="relative z-10">Watchlist</span>
      </button>
      <button
        type="button"
        onClick={() => setSidebarTab("screener")}
        className={`relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-full transition-colors ${sidebarTab === "screener" ? "text-background" : "text-muted-foreground hover:text-foreground"}`}
      >
        {sidebarTab === "screener" && <motion.div layoutId="desktopTabIndicator" className="absolute inset-0 bg-foreground rounded-full" transition={SPRING_SNAPPY} />}
        <span className="relative z-10">Screener</span>
      </button>
    </div>
  ), [sidebarTab]);

  const mobileTabHeader = useMemo(() => (
    <div className="flex items-center p-0.5 bg-foreground/5 rounded-full relative shrink-0 mr-4">
      <button
        type="button"
        onClick={() => setSidebarTab("watchlist")}
        className={`relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-full transition-colors ${sidebarTab === "watchlist" ? "text-background" : "text-muted-foreground hover:text-foreground"}`}
      >
        {sidebarTab === "watchlist" && <motion.div layoutId="mobileTabIndicator" className="absolute inset-0 bg-foreground rounded-full" transition={SPRING_SNAPPY} />}
        <span className="relative z-10">Watchlist</span>
      </button>
      <button
        type="button"
        onClick={() => setSidebarTab("screener")}
        className={`relative px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-full transition-colors ${sidebarTab === "screener" ? "text-background" : "text-muted-foreground hover:text-foreground"}`}
      >
        {sidebarTab === "screener" && <motion.div layoutId="mobileTabIndicator" className="absolute inset-0 bg-foreground rounded-full" transition={SPRING_SNAPPY} />}
        <span className="relative z-10">Screener</span>
      </button>
    </div>
  ), [sidebarTab]);

  // First load: hold a clean splash until system status resolves so the UI never
  // paints default/unauthorized states that flip a second later.
  if (statusQuery.isPending) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-background text-foreground">
        <span className="font-mono text-2xl font-normal tracking-[0.3em]">MIMIR</span>
        <span className="h-1.5 w-1.5 rounded-full bg-foreground/60 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="relative flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground font-sans">
      {/* Background is purely dark black now */}
      
      <div className="z-10 flex h-full flex-col overflow-hidden">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={FADE_STANDARD}
        >
          <TopBar
            indices={indicesQuery.data ?? null}
            status={statusQuery.data}
            wsConnected={wsConnected}
            onAuthorize={authorizeUpstox}
            authorizing={authorizing}
            activeSignals={activeSymbols.size}
            activeSignalCount={(suggestionsQuery.data ?? []).filter(s => s.status === "ACTIVE" || s.status === "PENDING").length}
            scanning={scanning}
            scanProgress={
              scanState.total > 0 
                ? (scanState.current / scanState.total) * 100 
                : sessionQuery.data?.scanProgress 
                  ? (sessionQuery.data.scanProgress.current / Math.max(sessionQuery.data.scanProgress.total, 1)) * 100 
                  : undefined
            }
            onOpenSuggestions={openSuggestions}
            onOpenPaperTrading={openPaperTrading}
            onOpenReports={openReports}
            onOpenSettings={openSettings}
            onOpenEventFeed={openEventFeed}
            onSelectSymbol={setSelectedSymbol}
          />
        </motion.div>

        <AnimatePresence>
          {apiError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={SPRING_GENTLE}
              className="shrink-0 px-2 py-0.5 overflow-hidden"
            >
              <p className="text-xs font-normal text-destructive">{apiError}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="min-h-0 flex-1 overflow-hidden p-4 pt-2">
          <div className="hidden lg:flex w-full h-full gap-0">
            {/* Left Column: Chart (Top) & Watchlist (Bottom) */}
            <div className="flex flex-col w-[65%] xl:w-[72%] min-w-0 h-full pr-2">
                  <motion.div 
                    className="flex-[65] w-full min-h-0 min-w-0 rounded-2xl mb-3 relative z-10"
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...FADE_STANDARD, delay: 0.05 }}
                  >
                  <AnimatePresence mode="wait">
                    {showClock ? (
                      <motion.div
                        key="scan-progress"
                        className="w-full h-full flex flex-col items-center justify-center bg-transparent"
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={FADE_STANDARD}
                      >
                        <ScanClockPanel 
                          scanProgress={scanState.total > 0 ? (scanState.current / scanState.total) * 100 : undefined}
                        />
                      </motion.div>
                    ) : (
                      <motion.div 
                        key="price-chart"
                        className="w-full h-full"
                        initial={{ opacity: 0, scale: 0.98 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={FADE_FAST}
                      >
                        <PriceChart 
                          symbol={activeSymbol} 
                          chartMode={chartMode} 
                          onChartModeChange={(m) => setChartMode(m)} 
                          isMarketOpen={session?.isMarketOpen} 
                          suggestion={suggestions.find(s => s.symbol === activeSymbol)} 
                          position={positions.find((p: import("@/types/api").PaperPosition) => p.symbol === activeSymbol && p.status === "OPEN")}
                          isAuthenticated={status?.upstoxAuthenticated}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                  </motion.div>
                
                  <motion.div 
                    className="flex-[35] w-full min-h-0 min-w-0 pt-2 flex flex-col"
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...FADE_STANDARD, delay: 0.1 }}
                  >
                    <div className="flex-1 min-h-0 relative">
                      {sidebarTab === "watchlist" ? (
                        <WatchlistStack
                          headerLeft={desktopTabHeader}
                          items={watchlistItems}
                          monitored={monitoring?.monitoredStocks}
                          suggestions={suggestions}
                          selectedSymbol={activeSymbol}
                          sparklines={sparklinesQuery.data}
                          watchlistMetadata={watchlistMetadata}
                          onSelect={setSelectedSymbol}
                        />
                      ) : (
                        <ScreenerTargetsStack
                          headerLeft={desktopTabHeader}
                          selectedSymbol={activeSymbol}
                          sparklines={sparklinesQuery.data}
                          onSelect={setSelectedSymbol}
                        />
                      )}
                    </div>
                  </motion.div>
            </div>

            {/* Right Column: Detail Panel */}
            <div className="flex flex-col w-[35%] xl:w-[28%] min-w-0 h-full pl-2">
              <motion.div 
                className="h-full w-full min-h-0 min-w-0 rounded-2xl relative z-10 overflow-hidden"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ ...FADE_STANDARD, delay: 0.12 }}
              >
                <DetailPanel
                  key={activeSymbol}
                  suggestions={suggestions}
                  selectedSymbol={activeSymbol}
                  session={session}
                  isScanActive={isScanActive}
                />
              </motion.div>
            </div>
          </div>

          {/* Mobile Fallback */}
          <div className="flex lg:hidden flex-col gap-4 h-full overflow-y-auto">
            <div className="h-[500px]">
              <AnimatePresence mode="wait">
                {isScanActive ? (
                  <motion.div 
                    key="scan-progress-mobile"
                    className="w-full h-full flex flex-col items-center justify-center bg-transparent"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={FADE_STANDARD}
                  >
                    <ScanClockPanel 
                      scanProgress={
                        scanState.total > 0 
                          ? (scanState.current / scanState.total) * 100 
                          : 0
                      }
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="price-chart-mobile"
                    className="w-full h-full"
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={FADE_FAST}
                  >
                    <PriceChart 
                      symbol={activeSymbol} 
                      chartMode={chartMode} 
                      onChartModeChange={(m) => setChartMode(m)} 
                      isMarketOpen={session?.isMarketOpen} 
                      suggestion={suggestions.find(s => s.symbol === activeSymbol)} 
                      position={positions.find((p: import("@/types/api").PaperPosition) => p.symbol === activeSymbol && p.status === "OPEN")}
                      isAuthenticated={status?.upstoxAuthenticated} 
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="h-[400px] flex flex-col">
              <div className="flex-1 min-h-0 relative">
                {sidebarTab === "watchlist" ? (
                  <WatchlistStack
                    headerLeft={mobileTabHeader}
                    items={watchlistItems} monitored={monitoring?.monitoredStocks} suggestions={suggestions} selectedSymbol={activeSymbol} sparklines={sparklinesQuery.data} watchlistMetadata={watchlistMetadata} onSelect={setSelectedSymbol}
                  />
                ) : (
                  <ScreenerTargetsStack
                    headerLeft={mobileTabHeader}
                    selectedSymbol={activeSymbol} sparklines={sparklinesQuery.data} onSelect={setSelectedSymbol}
                  />
                )}
              </div>
            </div>
            <div className="h-[400px]">
              <DetailPanel key={activeSymbol} suggestions={suggestions} selectedSymbol={activeSymbol} session={session} isScanActive={isScanActive} />
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
        <SuggestionsSlider isOpen={isSuggestionsOpen} onClose={() => setIsSuggestionsOpen(false)} onSelectSymbol={(s) => setSelectedSymbol(s)} activeSuggestions={suggestions} />
        <PaperTradingPanel isOpen={isPaperTradingOpen} onClose={() => setIsPaperTradingOpen(false)} />
        <ReportsLibrary isOpen={isReportsOpen} onClose={() => setIsReportsOpen(false)} />
        <SettingsDialog isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
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


