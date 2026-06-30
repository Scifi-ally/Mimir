import { useEffect, useMemo, useState, startTransition, lazy, Suspense } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { TopBar } from "@/components/TopBar";
import { PriceChart } from "@/components/PriceChart";
import { WatchlistStack } from "@/components/WatchlistStack";
import { DetailPanel } from "@/components/DetailPanel";
import { StatusBar } from "@/components/StatusBar";
const SuggestionsSlider = lazy(() => import("@/components/SuggestionsSlider").then(m => ({ default: m.SuggestionsSlider })));
const PaperTradingPanel = lazy(() => import("@/components/PaperTradingPanel").then(m => ({ default: m.PaperTradingPanel })));
import { Key } from "lucide-react";
import { useWebSocket } from "@/hooks/useWebSocket";
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

  const sessionQuery = useQuery({ queryKey: ["session"], queryFn: api.sessionState, refetchInterval: 10000 });
  const statusQuery = useQuery({ queryKey: ["status"], queryFn: api.systemStatus, refetchInterval: 10000 });
  const watchlistQuery = useQuery({ queryKey: ["watchlist"], queryFn: api.watchlistToday, refetchInterval: 10000 });
  const suggestionsQuery = useQuery<Suggestion[]>({ queryKey: ["suggestions"], queryFn: () => api.activeSuggestions(), refetchInterval: 10000 });
  const positionsQuery = useQuery({ queryKey: ["positions"], queryFn: () => api.paper.positions(), refetchInterval: 10000 });
  const indicesQuery = useQuery({ queryKey: ["indices"], queryFn: api.dashboardIndices, staleTime: Infinity });
  const regimeQuery = useQuery({ queryKey: ["regime"], queryFn: api.marketRegime, refetchInterval: 10000 });
  const monitoringQuery = useQuery({ queryKey: ["monitoring"], queryFn: api.intradayMonitoring, refetchInterval: 10000 });
  const indianContextQuery = useQuery({ queryKey: ["indian-context"], queryFn: api.indianContext, refetchInterval: 60000 });
  const scanStatusQuery = useQuery({ queryKey: ["scanStatus"], queryFn: api.scanStatus, refetchInterval: 10000, enabled: scanState.scanning || Boolean(sessionQuery.data?.scanRunning) });
  const scanning = scanState.scanning || Boolean(sessionQuery.data?.scanRunning);
  const activeCandidates = scanStatusQuery.data?.offhours?.activeCandidates || [];

  const watchlistItems = useMemo(() => {
    if (scanning) {
      return activeCandidates.map((log: any) => ({
        symbol: log.symbol,
        name: log.symbol,
        category: "SCANNED",
        condition: log.reason || "Live Scan Candidate",
        priority: 10,
      }));
    }
    const items = flattenWatchlist(watchlistQuery.data);
    const suggestionsData = suggestionsQuery.data ?? [];
    const activeSymbols = new Set(suggestionsData.filter(s => s.status === "ACTIVE").map(s => s.symbol));
    return items.sort((a, b) => {
      const aActive = activeSymbols.has(a.symbol) ? 1 : 0;
      const bActive = activeSymbols.has(b.symbol) ? 1 : 0;
      return bActive - aActive;
    });
  }, [watchlistQuery.data, scanning, activeCandidates, suggestionsQuery.data]);

  const watchlistSymbols = useMemo(() => {
    return watchlistItems.map(r => r.symbol);
  }, [watchlistItems]);

  const sparklinesQuery = useQuery({
    queryKey: ["sparklines", watchlistSymbols],
    queryFn: () => api.sparklines(watchlistSymbols),
    staleTime: 5 * 60 * 1000,
    enabled: watchlistSymbols.length > 0
  });

  const session = sessionQuery.data;
  const status = statusQuery.data;
  const suggestions = suggestionsQuery.data ?? [];
  const positions = positionsQuery.data ?? [];
  const regime = regimeQuery.data;
  const monitoring = monitoringQuery.data;
  const indianContext = indianContextQuery.data;

  const indices = indicesQuery.data ?? null;
  const isIndex = ["NIFTY 50", "BANKNIFTY", "FINNIFTY", "INDIA VIX", "SENSEX"].includes(selectedSymbol);
  const activeSymbol = watchlistItems.length === 0 && !isIndex
    ? "NIFTY 50"
    : (selectedSymbol || watchlistItems[0]?.symbol || "");

  useEffect(() => {
    if (!selectedSymbol && watchlistItems.length > 0) {
      startTransition(() => setSelectedSymbol(watchlistItems[0]!.symbol));
    }
  }, [watchlistItems, selectedSymbol, setSelectedSymbol]);

  // Clear stale selection if watchlist is empty, allowing indices to persist
  useEffect(() => {
    if (watchlistItems.length === 0 && selectedSymbol && !isIndex && !watchlistQuery.isPending) {
      startTransition(() => setSelectedSymbol(""));
    }
  }, [watchlistItems.length, selectedSymbol, isIndex, setSelectedSymbol, watchlistQuery.isPending]);

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

  const setLatestAlert = useStore((s) => s.setLatestAlert);

  // Global Keyboard Navigation
  useHotkeys("p", (e) => {
    e.preventDefault();
    startTransition(() => setIsSuggestionsOpen(prev => !prev));
  }, { preventDefault: true });

  useHotkeys(["up", "down", "left", "right"], (e) => {
    e.preventDefault();
    if (watchlistItems.length === 0) return;
    const currentIndex = watchlistItems.findIndex((item: any) => item.symbol === activeSymbol);
    
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
  }, [watchlistItems, activeSymbol, setSelectedSymbol]);

  // Token Expiry Alert Logic
  useEffect(() => {
    if (status?.upstoxTokenExpiry) {
      const msLeft = status.upstoxTokenExpiry - Date.now();
      const fifteenMins = 15 * 60 * 1000;
      if (msLeft > 0 && msLeft < fifteenMins) {
        const mins = Math.ceil(msLeft / 60000);
        setLatestAlert(`⚠️ Upstox session expires in ${mins} minutes. Re-authorize soon!`);
      }
    }
  }, [status?.upstoxTokenExpiry, setLatestAlert]);




  const showIsland = useStore((s) => s.showIsland);

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

  const authorizeUpstox = () => {
    showIsland({
      title: "Authorize Upstox",
      subtitle: "Redirecting to Upstox login to grant access to trading capabilities and market data.",
      icon: <Key className="w-8 h-8 text-destructive" />,
      confirmText: "Authorize",
      cancelText: "Cancel",
      isDestructive: true,
      onConfirm: async () => {
        setAuthorizing(true);
        setAuthError(null);
        try {
          const data = await api.authUrl();
          if (data.alreadyAuthenticated) return true;
          if (!data.url) throw new Error(data.error || "Authorization URL unavailable");
          
          localStorage.setItem("upstox_auth_pending", "true");
          window.location.assign(data.url);
          return false; // Prevent success tick, keep loader spinning until page unloads
        } catch (error) {
          setAuthError(error instanceof Error ? error.message : "Authorization failed");
          setAuthorizing(false);
          throw error; 
        }
      },
    });
  };

  const apiError = authError || sessionQuery.error?.message || watchlistQuery.error?.message || null;

  return (
    <div className="relative flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-accent/5 via-background to-background" />
      
      <div className="z-10 flex h-full flex-col overflow-hidden">
        <motion.div
          initial={{ opacity: 0, y: -20, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ type: "spring", stiffness: 350, damping: 35, mass: 0.8, delay: 0.05 }}
        >
          <TopBar
          indices={indices}
          session={session}
          status={status}
          wsConnected={wsConnected}
          onAuthorize={authorizeUpstox}
          authorizing={authorizing}
          watchlistDate={undefined}
          activeSignals={suggestions.filter((s) => s.status === "ACTIVE").length}
          scanning={scanning}
          scanProgress={scanning && scanState.total > 0 ? (scanState.current / scanState.total) * 100 : 0}
          onOpenSuggestions={() => startTransition(() => setIsSuggestionsOpen(true))}
          onOpenPaperTrading={() => startTransition(() => setIsPaperTradingOpen(true))}
          onSelectSymbol={(s) => startTransition(() => setSelectedSymbol(s))}
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
          <div className="hidden lg:flex w-full h-full gap-0">
            {/* Left Column: Chart (Top) & Watchlist (Bottom) */}
            <div className="flex flex-col w-[65%] xl:w-[72%] min-w-0 h-full pr-2">
                  <motion.div 
                    className="flex-[60] w-full min-h-0 min-w-0 pb-2"
                    initial={{ opacity: 0, y: 30, scale: 0.97, filter: "blur(10px)" }}
                    animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                    transition={{ type: "spring", stiffness: 300, damping: 30, mass: 0.9, delay: 0.1 }}
                  >
                    <PriceChart 
                      symbol={activeSymbol} 
                      chartMode={chartMode} 
                      onChartModeChange={(m) => startTransition(() => setChartMode(m))} 
                      isMarketOpen={session?.isMarketOpen} 
                      suggestion={suggestions.find(s => s.symbol === activeSymbol)} 
                      position={positions.find((p: any) => p.symbol === activeSymbol && p.status === "OPEN")}
                      isAuthenticated={status?.upstoxAuthenticated}
                    />
                  </motion.div>
                
                  <motion.div 
                    className="flex-[40] w-full min-h-0 min-w-0 pt-2"
                    initial={{ opacity: 0, y: 30, scale: 0.97, filter: "blur(10px)" }}
                    animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                    transition={{ type: "spring", stiffness: 300, damping: 30, mass: 0.9, delay: 0.18 }}
                  >
                    <WatchlistStack 
                      items={watchlistItems} 
                      monitored={monitoring?.monitoredStocks} 
                      suggestions={suggestions} 
                      selectedSymbol={activeSymbol} 
                      sparklines={sparklinesQuery.data}
                      onSelect={(s) => startTransition(() => setSelectedSymbol(s))} 
                    />
                  </motion.div>
            </div>

            {/* Right Column: Detail Panel */}
            <div className="flex flex-col w-[35%] xl:w-[28%] min-w-0 h-full pl-2">
              <motion.div 
                className="h-full w-full min-h-0 min-w-0"
                initial={{ opacity: 0, x: 20, filter: "blur(10px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                transition={{ type: "spring", stiffness: 300, damping: 30, mass: 0.9, delay: 0.25 }}
              >
                <DetailPanel
                  suggestions={suggestions}
                  selectedSymbol={activeSymbol}
                  session={session}
                />
              </motion.div>
            </div>
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
                position={positions.find((p: any) => p.symbol === activeSymbol && p.status === "OPEN")}
                isAuthenticated={status?.upstoxAuthenticated} 
              />
            </div>
            <div className="h-[400px]">
              <WatchlistStack items={watchlistItems} monitored={monitoring?.monitoredStocks} suggestions={suggestions} selectedSymbol={activeSymbol} sparklines={sparklinesQuery.data} onSelect={(s) => startTransition(() => setSelectedSymbol(s))} />
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
        <SuggestionsSlider isOpen={isSuggestionsOpen} onClose={() => startTransition(() => setIsSuggestionsOpen(false))} onSelectSymbol={(s) => startTransition(() => setSelectedSymbol(s))} />
      </Suspense>
      <Suspense fallback={null}>
        <PaperTradingPanel isOpen={isPaperTradingOpen} onClose={() => startTransition(() => setIsPaperTradingOpen(false))} />
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
