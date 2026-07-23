import { KeyRound, Moon, Sun, Play, BarChart2, Wallet, Plus, Loader2, FileText, Bell, Settings, CheckCircle2, AlertCircle, Zap } from "lucide-react";
import { useState, useEffect, memo, useRef } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { flushSync } from "react-dom";
import { cn, toFixed } from "@/lib/format";
import { Button } from "@/components/mimir/button";
import type { DashboardIndices, SessionState, SystemStatus } from "@/types/api";
import { useStore } from "@/store/useStore";
import AnimatedNumber from "@/components/atoms/AnimatedNumber";

interface TopBarProps {
  indices: DashboardIndices | null;
  status: SystemStatus | undefined;
  wsConnected: boolean;
  onAuthorize: (type?: "trading" | "data") => void;
  authorizing: boolean;
  scanning?: boolean;
  scanProgress?: number;
  onOpenSuggestions: () => void;
  onOpenPaperTrading: () => void;
  onOpenReports: () => void;
  onOpenEventFeed: () => void;
  onOpenSettings: () => void;
  onSelectSymbol?: (symbol: string) => void;
}

import { api } from "@/lib/api";
import { SPRING_SNAPPY } from "@/lib/motion";

export const TopBar = memo(function TopBar({
  indices,
  status,
  wsConnected,
  onAuthorize,
  authorizing,
  scanning,
  scanProgress,
  onOpenSuggestions,
  onOpenPaperTrading,
  onOpenReports,
  onOpenEventFeed,
  onOpenSettings,
  onSelectSymbol,
}: TopBarProps) {

  const isLight = useStore((s) => s.theme) === "light";
  const themeButtonRef = useRef<HTMLButtonElement>(null);
  const [startingScan, setStartingScan] = useState(false);
  const [stoppingScan, setStoppingScan] = useState(false);
  const queryClient = useQueryClient();
  const { data: tradingMode } = useQuery({
    queryKey: ["trading-mode"],
    queryFn: api.tradingMode,
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const isLiveTrading = tradingMode?.mode === "LIVE";
  const isDualKeyConfigured = Boolean(status?.useDualApiKeys);
  const authorizedKeysCount = (status?.upstoxFeedAuthenticated ? 1 : 0) + (status?.upstoxDataAuthenticated ? 1 : 0);

  const showIsland = useStore((s) => s.showIsland);
  const hideIsland = useStore((s) => s.hideIsland);
  const unreadCount = useStore(s => s.events.length);



  useEffect(() => {
    if (scanning) {
      setStartingScan(false);
    }
  }, [scanning]);

  const handleRunScan = async () => {
    if (startingScan) return; // guard double-click before scanning state flips
    setStartingScan(true);
    try {
      await api.triggerScan();
      useStore.getState().setScanState({ scanning: true, phase: "running", current: 0, total: 100 });
      queryClient.setQueryData(["session"], (old: SessionState | undefined) => old ? { ...old, scanRunning: true } : old);
    } catch (err) {
      setStartingScan(false);
      useStore.getState().setScanState({ scanning: false, phase: "completed", current: 0, total: 0 });
      queryClient.setQueryData(["session"], (old: SessionState | undefined) => old ? { ...old, scanRunning: false } : old);
      if (err instanceof Error) {
        showIsland({ isNotification: true, title: "Scan Failed", subtitle: err.message, showSuccessOnly: false });
      } else {
        showIsland({ isNotification: true, title: "Scan Failed", subtitle: "An unknown error occurred", showSuccessOnly: false });
      }
    }
  };

  const handleScanButtonClick = async () => {
    if (scanning) {
      showIsland({
        icon: <Play strokeWidth={3} className="w-6 h-6" />,
        title: "Stop Market Scan?",
        subtitle: "This will halt the current scanning process immediately.",
        confirmText: "Stop Scan",
        isDestructive: true,
        onConfirm: async () => {
            setStoppingScan(true);
          try {
            await api.stopScan();
            useStore.getState().setScanState({ scanning: false, phase: "completed", current: 0, total: 0 });
            queryClient.setQueryData(["session"], (old: SessionState | undefined) => old ? { ...old, scanRunning: false } : old);
          } catch (err) {
            showIsland({ isNotification: true, title: "Failed to stop scan", subtitle: err instanceof Error ? err.message : "Unknown error", showSuccessOnly: false });
          } finally {
            setStoppingScan(false);
          }
        },
      });
    } else {
      await handleRunScan();
    }
  };

  const toggleTheme = (e: React.MouseEvent) => {
    // ALWAYS use the exact button's physical DOM rect on the screen to guarantee the exact origin.
    // We prefer themeButtonRef over e.currentTarget to bypass any synthetic event propagation anomalies.
    let rect: DOMRect;
    if (themeButtonRef.current) {
      rect = themeButtonRef.current.getBoundingClientRect();
    } else {
      rect = e.currentTarget.getBoundingClientRect();
    }
    
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // --- DEBUG VISUALIZER ---
    const dot = document.createElement("div");
    dot.style.position = "fixed";
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    dot.style.width = "12px";
    dot.style.height = "12px";
    dot.style.backgroundColor = "#FF0000"; // bright red
    dot.style.borderRadius = "50%";
    dot.style.transform = "translate(-50%, -50%)";
    dot.style.zIndex = "2147483647"; // max z-index
    dot.style.pointerEvents = "none";
    dot.style.boxShadow = "0 0 10px #FF0000";
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 4000);
    console.log(`[Theme Toggle] Calculated origin -> X: ${x}, Y: ${y}`);
    // ------------------------

    const willBeLight = !isLight;
    
    if (!document.startViewTransition) {
      flushSync(() => {
        document.documentElement.classList.toggle("light", willBeLight);
        useStore.getState().setTheme(willBeLight ? "light" : "dark");
      });
      window.dispatchEvent(new Event("themechange"));
      return;
    }

    document.documentElement.style.setProperty("--theme-origin-x", `${x}px`);
    document.documentElement.style.setProperty("--theme-origin-y", `${y}px`);
    document.documentElement.classList.add("theme-transitioning");

    const transition = document.startViewTransition(() => {
      flushSync(() => {
        document.documentElement.classList.toggle("light", willBeLight);
        useStore.getState().setTheme(willBeLight ? "light" : "dark");
      });
      window.dispatchEvent(new Event("themechange"));
    });

    transition.finished.finally(() => {
      document.documentElement.classList.remove("theme-transitioning");
    });
  };

  return (
    <>
      <div className="h-[calc(48px+env(safe-area-inset-top))] w-full shrink-0" />
      <header
        className={cn(
          "fixed top-0 left-0 right-0 z-50 flex w-full shrink-0 flex-col justify-end bg-background/90 backdrop-blur-xl backdrop-saturate-150 px-4 sm:px-6 py-1.5 h-[calc(48px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]"
        )}
      >
        <div className="flex flex-col w-full">
          <div className="flex w-full min-w-0 items-center justify-between gap-3 sm:gap-4 whitespace-nowrap">
            <div className="hidden sm:flex min-w-0 flex-1 items-center gap-x-3 pr-2 relative">

          <div className="flex min-w-0 shrink items-center gap-3 text-[11px] font-normal text-foreground/50 overflow-x-auto [&::-webkit-scrollbar]:hidden">
            <IndexMetric label="NIFTY 50" ltp={indices?.nifty50?.ltp} changePct={indices?.nifty50?.changePct} storeKey="nifty" onSelect={() => onSelectSymbol?.("NIFTY 50")} />
            <div className="hidden sm:contents">
              <IndexMetric label="SENSEX" ltp={indices?.sensex?.ltp} changePct={indices?.sensex?.changePct} storeKey="sensex" onSelect={() => onSelectSymbol?.("SENSEX")} />
            </div>
            <div className="hidden lg:contents">
              <IndexMetric label="BANK NIFTY" ltp={indices?.bankNifty?.ltp} changePct={indices?.bankNifty?.changePct} storeKey="banknifty" onSelect={() => onSelectSymbol?.("BANKNIFTY")} />
            </div>
            <div className="hidden xl:contents">
              <IndexMetric label="FIN NIFTY" ltp={indices?.finnifty?.ltp} changePct={indices?.finnifty?.changePct} storeKey="finnifty" onSelect={() => onSelectSymbol?.("FINNIFTY")} />
              <IndexMetric label="INDIA VIX" ltp={indices?.indiaVix?.ltp} isVix storeKey="vix" onSelect={() => onSelectSymbol?.("INDIA VIX")} />
            </div>
          </div>
        </div>

        <div className="flex min-w-0 w-full sm:w-auto sm:max-w-[65vw] shrink items-center justify-end gap-1.5 sm:gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden pl-2 pb-1 -mb-1">
          <div className="flex shrink-0 items-center gap-1">
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={SPRING_SNAPPY}>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleScanButtonClick}
              disabled={startingScan || stoppingScan}
              className={cn(
                "apple-hover relative overflow-hidden h-7 text-[10px] px-3 font-medium bg-foreground/[0.03] transition-all duration-200 rounded-lg",
                scanning
                  ? "text-foreground hover:bg-red-500/10 hover:text-red-500"
                  : "text-foreground/70 hover:bg-foreground/[0.08] hover:text-foreground"
              )}
              title={scanning ? "Stop the active scanner" : "Manually restart the full market scanner"}
            >
              {scanning && scanProgress !== undefined && (
                <div 
                  className="absolute left-0 top-0 bottom-0 bg-bull/30 transition-all duration-500 ease-out"
                  style={{ width: `${scanProgress || 0}%` }}
                />
              )}
              <span className="relative z-10 flex items-center justify-center min-w-[32px]">
                {scanning && scanProgress !== undefined ? (
                  <span className="text-[10px] font-mono font-medium text-foreground px-1">
                    {scanProgress > 0 && scanProgress < 100 ? toFixed(scanProgress, 1) : Math.round(scanProgress || 0)}%
                  </span>
                ) : (
                  <Play strokeWidth={3} className={cn("h-4 w-4", startingScan && "animate-pulse text-bull")} />
                )}
              </span>
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={SPRING_SNAPPY}>
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenSuggestions}
              className="apple-hover h-7 flex items-center gap-1.5 text-[10px] px-3 font-medium bg-foreground/[0.03] text-foreground/70 hover:bg-foreground/[0.08] hover:text-foreground transition-all duration-200 rounded-lg"
              title="View Signals Generated"
            >
              <BarChart2 strokeWidth={3} className="h-3.5 w-3.5 sm:mr-0.5" />
              <span className="hidden sm:inline">Signals</span>
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={SPRING_SNAPPY}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => useStore.getState().setCommandPaletteOpen(true, "scan ")}
              className="h-7 w-7 p-0 flex items-center justify-center text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground transition-all duration-200 rounded-lg"
              title="Add Custom Screener Condition"
            >
              <Plus strokeWidth={3} className="h-3.5 w-3.5" />
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={SPRING_SNAPPY}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenReports}
              className="h-7 w-7 p-0 flex items-center justify-center text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground transition-all duration-200 rounded-lg"
              title="Open Daily Reports"
            >
              <FileText strokeWidth={3} className="h-3.5 w-3.5" />
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={SPRING_SNAPPY}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenPaperTrading}
              className={cn(
                "h-7 w-7 p-0 flex items-center justify-center transition-all duration-200 rounded-lg relative",
                isLiveTrading
                  ? "text-destructive hover:bg-destructive/10"
                  : "text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground"
              )}
              title={isLiveTrading ? "Open Live Trading (REAL ORDERS)" : "Open Paper Trading"}
            >
              <Wallet strokeWidth={3} className="h-3.5 w-3.5" />
              {isLiveTrading && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-destructive animate-pulse" />
              )}
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={SPRING_SNAPPY}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenEventFeed}
              className="relative h-7 w-7 p-0 flex items-center justify-center text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground transition-all duration-200 rounded-lg"
              title="Activity Feed"
            >
              <Bell strokeWidth={3} className="h-3.5 w-3.5" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-[8px] font-normal text-white">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={SPRING_SNAPPY}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenSettings}
              className="h-7 w-7 p-0 flex items-center justify-center text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground transition-all duration-200 rounded-lg"
              title="System Configuration & Settings"
            >
              <Settings strokeWidth={3} className="h-3.5 w-3.5" />
            </Button>
            </motion.div>

            <div className="relative">
              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={SPRING_SNAPPY}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (isDualKeyConfigured) {
                      showIsland({
                        title: "Upstox API Keys Status",
                        hideCancel: true, // HMR trigger
                        content: (
                            <div className="flex flex-col gap-3 py-2 w-full mt-2">
                              <div className="flex items-center justify-between px-1">
                                <div className="flex items-center gap-2">
                                  <Zap className="h-4 w-4 text-blue-400" />
                                  <span className="text-[13px] font-normal text-foreground">Live Feed Key</span>
                                </div>
                                <div className="flex items-center gap-1 text-[12px]">
                                  {status?.upstoxFeedAuthenticated ? (
                                    <span className="text-bull flex items-center gap-1 font-normal bg-bull/10 px-2 py-0.5 rounded">
                                      <CheckCircle2 strokeWidth={3} className="h-3 w-3" />
                                      {status.upstoxFeedTokenExpiry ? <TokenExpiryDisplay expiry={status.upstoxFeedTokenExpiry} /> : "Verified"}
                                    </span>
                                  ) : (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); hideIsland(); onAuthorize("trading"); }}
                                      disabled={authorizing}
                                      className="text-red-400 hover:text-red-300 hover:bg-red-400/20 transition-colors flex items-center gap-1 font-normal bg-red-400/10 px-2 py-0.5 rounded cursor-pointer disabled:opacity-50"
                                    >
                                      <AlertCircle strokeWidth={3} className="h-3 w-3" />
                                      Authorize
                                    </button>
                                  )}
                                </div>
                              </div>
                              
                              <div className="flex items-center justify-between px-1">
                                <div className="flex items-center gap-2">
                                  <BarChart2 strokeWidth={3} className="h-4 w-4 text-orange-400" />
                                  <span className="text-[13px] font-normal text-foreground">Analysis Key</span>
                                </div>
                                <div className="flex items-center gap-1 text-[12px]">
                                  {status?.upstoxDataAuthenticated ? (
                                    <span className="text-bull flex items-center gap-1 font-normal bg-bull/10 px-2 py-0.5 rounded">
                                      <CheckCircle2 strokeWidth={3} className="h-3 w-3" />
                                      {status.upstoxDataTokenExpiry ? <TokenExpiryDisplay expiry={status.upstoxDataTokenExpiry} /> : "Verified"}
                                    </span>
                                  ) : (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); hideIsland(); onAuthorize("data"); }}
                                      disabled={authorizing}
                                      className="text-red-400 hover:text-red-300 hover:bg-red-400/20 transition-colors flex items-center gap-1 font-normal bg-red-400/10 px-2 py-0.5 rounded cursor-pointer disabled:opacity-50"
                                    >
                                      <AlertCircle strokeWidth={3} className="h-3 w-3" />
                                      Authorize
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                        )
                      });
                    } else {
                      if (status?.upstoxAuthenticated) {
                        showIsland({
                          title: "Upstox API Key Status",
                          hideCancel: true,
                          content: (
                            <div className="flex flex-col gap-3 py-2 w-full mt-2">
                              <div className="flex items-center justify-between px-1">
                                <div className="flex items-center gap-2">
                                  <Zap className="h-4 w-4 text-blue-400" />
                                  <span className="text-[13px] font-normal text-foreground">API Key</span>
                                </div>
                                <div className="flex items-center gap-1 text-[12px]">
                                  <span className="text-bull flex items-center gap-1 font-normal bg-bull/10 px-2 py-0.5 rounded">
                                    <CheckCircle2 strokeWidth={3} className="h-3 w-3" />
                                    {status.upstoxTokenExpiry ? <TokenExpiryDisplay expiry={status.upstoxTokenExpiry} /> : "Verified"}
                                  </span>
                                </div>
                              </div>
                            </div>
                          )
                        });
                      } else {
                        onAuthorize(status?.upstoxDataConfigured && !status?.upstoxFeedConfigured ? "data" : "trading");
                      }
                    }
                  }}
                  disabled={authorizing}
                  className={cn(
                    "apple-hover h-7 flex items-center gap-1.5 text-[11px] px-3 font-medium transition-all rounded-lg",
                    isDualKeyConfigured
                      ? authorizedKeysCount === 2
                        ? "text-bull bg-bull/10 hover:bg-bull/20"
                        : authorizedKeysCount === 1
                          ? "text-amber-500 bg-amber-500/10 hover:bg-amber-500/20"
                          : "text-red-500 hover:bg-red-500/10"
                      : status && !status.upstoxAuthenticated
                        ? "text-red-500 hover:bg-red-500/10"
                        : "bg-transparent text-foreground/80 hover:bg-foreground/10 hover:text-foreground"
                  )}
                  title={isDualKeyConfigured ? "Upstox Dual API Keys Status" : "Authorize Upstox"}
                >
                  {authorizing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin text-current" />
                      <span className="hidden sm:inline">Redirecting...</span>
                    </>
                  ) : isDualKeyConfigured ? (
                    <>
                      <KeyRound className={cn("h-4 w-4", authorizedKeysCount > 0 ? "text-current" : "text-red-500")} />
                      <span className="flex items-center gap-1 font-mono font-medium text-[12px] tracking-tight">
                        {authorizedKeysCount}/2
                      </span>
                    </>
                  ) : !status ? (
                    // Status unknown (loading/refetch gap) — neutral, never a false "Authorize" prompt
                    <span className="inline-block h-3 w-14 rounded bg-foreground/10 animate-pulse" />
                  ) : (
                    <>
                      <KeyRound className={cn("h-4 w-4", status.upstoxAuthenticated ? "text-bull" : "text-current")} />
                      {status.upstoxAuthenticated ? (
                        <span>{status.upstoxTokenExpiry ? <TokenExpiryDisplay expiry={status.upstoxTokenExpiry} /> : "Verified"}</span>
                      ) : (
                        <span>Authorize Upstox</span>
                      )}
                    </>
                  )}
                </Button>
              </motion.div>

            </div>
          </div>

          <motion.div whileHover={{ scale: 1.05, rotate: 12 }} whileTap={{ scale: 0.92 }} transition={SPRING_SNAPPY}>
          <Button
            ref={themeButtonRef}
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className="apple-hover shrink-0 h-6 w-6 flex items-center justify-center rounded-full bg-transparent text-foreground/60 hover:bg-foreground/10 hover:text-foreground transition-all duration-200"
          >
            {isLight ? <Moon strokeWidth={3} className="h-3.5 w-3.5" /> : <Sun strokeWidth={3} className="h-3.5 w-3.5" />}
          </Button>
          </motion.div>
          
          <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-foreground/60 px-1 font-sans">
            <span className={cn(
              "h-1.5 w-1.5 rounded-full", 
              wsConnected ? "bg-[#34C759] shadow-[0_0_8px_rgba(52,199,89,0.6)] animate-[pulse-bloom_4s_ease-in-out_infinite]" : "bg-red-500/80"
            )} />
            <span className="hidden sm:inline">{wsConnected ? "Live" : "Offline"}</span>
          </span>
        </div>
        </div>
          </div>
    </header>
    </>
  );
});

import { useSymbolDataSelector } from "@/providers/MarketDataProvider";

function IndexMetric({
  label,
  ltp,
  changePct,
  isVix,
  onSelect,
}: {
  label: string;
  ltp: number | null | undefined;
  changePct?: number | null;
  isVix?: boolean;
  storeKey: string;
  onSelect?: () => void;
}) {
  const storeLtp = useSymbolDataSelector(label, (d) => d.ltp);
  const storePct = useSymbolDataSelector(label, (d) => d.changePct);

  const displayLtp = storeLtp ?? ltp;
  const displayPct = storePct ?? changePct;
  const tone = displayPct == null ? "text-foreground/70" : displayPct >= 0 ? "text-bull" : "text-bear";

  // No data yet — show a quiet placeholder instead of animating up from 0
  if (displayLtp == null) {
    return (
      <span className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap px-1.5 py-0.5">
        <span className="text-foreground/40">{label}</span>
        <span className="inline-block h-3 w-12 rounded bg-foreground/10 animate-pulse" />
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap cursor-pointer hover:bg-foreground/5 px-1.5 py-0.5 rounded transition-colors"
    >
      <span className="text-foreground/45 font-sans">{label}</span>
      <strong className="text-foreground font-mono font-medium">
        <AnimatedNumber
          value={displayLtp}
          decimals={2}
          duration={0.3}
          flashColor={true}
        />
      </strong>
      {!isVix && displayPct != null && (
        <strong className={cn(tone, "font-mono font-medium")}>
          <AnimatedNumber
            value={displayPct}
            decimals={1}
            showSign={true}
            suffix="%"
            duration={0.3}
            flashColor={true}
          />
        </strong>
      )}
    </button>
  );
}

function TokenExpiryDisplay({ expiry }: { expiry: number }) {
  const [timeLeft, setTimeLeft] = useState<string | null>(null);

  useEffect(() => {
    const update = () => {
      const now = Date.now();
      const diff = expiry - now;
      if (diff <= 0) {
        setTimeLeft("Expired");
        return;
      }
      const hrs = Math.floor(diff / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setTimeLeft(hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`);
    };
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [expiry]);

  if (!timeLeft) return null;
  return <span className="opacity-80 tabular-nums">{timeLeft}</span>;
}

