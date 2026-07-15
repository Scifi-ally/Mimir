import { KeyRound, Moon, Sun, Play, BarChart2, Wallet, Plus, Loader2, FileText, Bell, Settings } from "lucide-react";
import { useState, useEffect, memo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { flushSync } from "react-dom";
import { cn, toFixed } from "@/lib/format";
import { Button } from "@/components/mimir/button";
import type { DashboardIndices, SystemStatus } from "@/types/api";
import { useStore } from "@/store/useStore";
import AnimatedNumber from "@/components/atoms/AnimatedNumber";

interface TopBarProps {
  indices: DashboardIndices | null;
  status: SystemStatus | undefined;
  wsConnected: boolean;
  onAuthorize: () => void;
  authorizing: boolean;
  activeSignals: number;
  activeSignalCount?: number;
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

export const TopBar = memo(function TopBar({
  indices,
  status,
  wsConnected,
  onAuthorize,
  authorizing,
  activeSignals,
  activeSignalCount = 0,
  scanning,
  scanProgress,
  onOpenSuggestions,
  onOpenPaperTrading,
  onOpenReports,
  onOpenEventFeed,
  onOpenSettings,
  onSelectSymbol,
}: TopBarProps) {

  const [isLight, setIsLight] = useState(false);
  const [startingScan, setStartingScan] = useState(false);
  const [stoppingScan, setStoppingScan] = useState(false);
  const queryClient = useQueryClient();

  const showIsland = useStore((s) => s.showIsland);
  const unreadCount = useStore(s => s.events.length);

  useEffect(() => {
    setIsLight(document.documentElement.classList.contains("light"));
  }, []);

  useEffect(() => {
    if (scanning) {
      setStartingScan(false);
    }
  }, [scanning]);

  const handleRunScan = async () => {
    setStartingScan(true);
    try {
      await api.triggerScan();
      useStore.getState().setScanState({ scanning: true, phase: "running", current: 0, total: 100 });
      queryClient.setQueryData(["session"], (old: any) => old ? { ...old, scanRunning: true } : old);
    } catch (err) {
      setStartingScan(false);
      useStore.getState().setScanState({ scanning: false, phase: "completed", current: 0, total: 0 });
      queryClient.setQueryData(["session"], (old: any) => old ? { ...old, scanRunning: false } : old);
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
        icon: <Play className="w-6 h-6" />,
        title: "Stop Market Scan?",
        subtitle: "This will halt the current scanning process immediately.",
        confirmText: "Stop Scan",
        isDestructive: true,
        onConfirm: async () => {
            setStoppingScan(true);
          try {
            await api.stopScan();
            useStore.getState().setScanState({ scanning: false, phase: "completed", current: 0, total: 0 });
            queryClient.setQueryData(["session"], (old: any) => old ? { ...old, scanRunning: false } : old);
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
    const x = e.clientX;
    const y = e.clientY;
    const willBeLight = !isLight;
    
    if (!document.startViewTransition) {
      flushSync(() => {
        document.documentElement.classList.toggle("light", willBeLight);
        setIsLight(willBeLight);
      });
      window.dispatchEvent(new Event("themechange"));
      return;
    }

    const transition = document.startViewTransition(() => {
      flushSync(() => {
        document.documentElement.classList.toggle("light", willBeLight);
        setIsLight(willBeLight);
      });
      window.dispatchEvent(new Event("themechange"));
    });

    transition.ready.then(() => {
      const endRadius = Math.hypot(
        Math.max(x, innerWidth - x),
        Math.max(y, innerHeight - y)
      );

      const clipPath = [
        `circle(0px at ${x}px ${y}px)`,
        `circle(${endRadius}px at ${x}px ${y}px)`,
      ];

      document.documentElement.animate(
        { clipPath },
        {
          duration: 450,
          easing: "cubic-bezier(0.87, 0, 0.13, 1)",
          pseudoElement: "::view-transition-new(root)",
          fill: "both",
        }
      );
    });
  };

  return (
    <>
      <div className="h-[52px] w-full shrink-0" />
      <header 
        className={cn(
          "fixed top-0 left-0 right-0 z-50 flex w-full shrink-0 flex-col justify-center bg-background/95 backdrop-blur-md border-b border-border/10 px-4 sm:px-6 py-2 h-[52px]"
        )}
      >
        <div className="flex flex-col w-full gap-2">
          {/* Top Row: Core Indices & Actions */}
          <div className="flex w-full min-w-0 items-center justify-between gap-2 sm:gap-4 whitespace-nowrap">
            <div className="flex min-w-0 flex-1 items-center gap-x-4 pr-2 relative">

          <div className="hidden sm:flex min-w-0 shrink items-center gap-4 text-[11px] font-medium text-foreground/70 overflow-x-auto [&::-webkit-scrollbar]:hidden">
            <IndexMetric label="NIFTY 50" ltp={indices?.nifty50.ltp} changePct={indices?.nifty50.changePct} storeKey="nifty" onSelect={() => onSelectSymbol?.("NIFTY 50")} />
            <IndexMetric label="SENSEX" ltp={indices?.sensex.ltp} changePct={indices?.sensex.changePct} storeKey="sensex" onSelect={() => onSelectSymbol?.("SENSEX")} />
            <IndexMetric label="BANK NIFTY" ltp={indices?.bankNifty.ltp} changePct={indices?.bankNifty.changePct} storeKey="banknifty" onSelect={() => onSelectSymbol?.("BANKNIFTY")} />
            <IndexMetric label="FIN NIFTY" ltp={indices?.finnifty.ltp} changePct={indices?.finnifty.changePct} storeKey="finnifty" onSelect={() => onSelectSymbol?.("FINNIFTY")} />
            <IndexMetric label="INDIA VIX" ltp={indices?.indiaVix.ltp} isVix storeKey="vix" onSelect={() => onSelectSymbol?.("INDIA VIX")} />
          </div>
        </div>

        <div className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-3">
          <div className="flex shrink-0 items-center gap-3 text-[11px] text-foreground/70">
            {!scanning && (activeSignalCount > 0 || activeSignals > 0) && (
              <button
                type="button"
                onClick={onOpenSuggestions}
                className="font-semibold text-bull whitespace-nowrap hover:underline flex items-center gap-1.5 transition-all cursor-pointer"
                title="Click to view all active signals"
              >
                <span className="w-2 h-2 rounded-full bg-bull animate-pulse inline-block shrink-0" />
                <span>
                  {activeSignalCount > 0 
                    ? `${activeSignalCount} active signal${activeSignalCount > 1 ? 's' : ''}` 
                    : `${activeSignals} active setups`}
                </span>
              </button>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleScanButtonClick}
              disabled={startingScan || stoppingScan}
              className={cn(
                "apple-hover relative overflow-hidden h-7 text-[10px] px-3 font-medium bg-transparent border border-border/50 transition-all duration-300 rounded-lg",
                scanning 
                  ? "text-foreground hover:bg-red-500/10 hover:text-red-500" 
                  : "text-foreground/80 hover:bg-foreground/10 hover:text-foreground"
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
                  <span className="text-[10px] font-mono font-bold text-foreground px-1">
                    {scanProgress > 0 && scanProgress < 100 ? toFixed(scanProgress, 1) : Math.round(scanProgress || 0)}%
                  </span>
                ) : (
                  <Play className={cn("h-4 w-4", startingScan && "animate-pulse text-bull")} />
                )}
              </span>
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenSuggestions}
              className="apple-hover h-7 flex items-center gap-1.5 text-[11px] px-3 font-medium bg-transparent border border-border/50 text-foreground/80 hover:bg-foreground/10 hover:text-foreground transition-all duration-300 rounded-lg"
              title="View Signals Generated"
            >
              <BarChart2 className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Signals</span>
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => useStore.getState().setCommandPaletteOpen(true, "scan ")}
              className="apple-hover h-7 w-7 p-0 flex items-center justify-center bg-transparent text-foreground/80 hover:bg-foreground/10 hover:text-foreground transition-all duration-300 rounded-lg"
              title="Add Custom Screener Condition"
            >
              <Plus className="h-4 w-4" />
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenReports}
              className="apple-hover h-7 w-7 p-0 flex items-center justify-center bg-transparent text-foreground/80 hover:bg-foreground/10 hover:text-foreground transition-all duration-300 rounded-lg"
              title="Open Daily Reports"
            >
              <FileText className="h-4 w-4" />
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenPaperTrading}
              className="apple-hover h-7 w-7 p-0 flex items-center justify-center bg-transparent text-foreground/80 hover:bg-foreground/10 hover:text-foreground transition-all duration-300 rounded-lg"
              title="Open Paper Trading"
            >
              <Wallet className="h-4 w-4" />
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenEventFeed}
              className="relative apple-hover h-7 w-7 p-0 flex items-center justify-center bg-transparent text-foreground/80 hover:bg-foreground/10 hover:text-foreground transition-all duration-300 rounded-lg"
              title="Activity Feed"
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-[8px] font-bold text-white shadow-sm">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenSettings}
              className="apple-hover h-7 w-7 p-0 flex items-center justify-center bg-transparent text-foreground/80 hover:bg-foreground/10 hover:text-foreground transition-all duration-300 rounded-lg"
              title="System Configuration & Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={onAuthorize}
              disabled={authorizing || status?.upstoxAuthenticated}
              className={cn(
                "apple-hover h-7 flex items-center gap-1.5 text-[11px] px-3 font-medium transition-all rounded-lg",
                !status?.upstoxAuthenticated
                  ? "text-red-500 hover:bg-red-500/10"
                  : "bg-transparent text-foreground/80 hover:bg-foreground/10 hover:text-foreground"
              )}
              title="Authorize Upstox"
            >
              {authorizing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-current" />
                  <span className="hidden sm:inline">Redirecting...</span>
                </>
              ) : (
                <>
                  <KeyRound className={cn("h-4 w-4", status?.upstoxAuthenticated ? "text-bull" : "text-current")} />
                  {status?.upstoxAuthenticated && status.upstoxTokenExpiry ? (
                    <span className="hidden sm:inline"><TokenExpiryDisplay expiry={status.upstoxTokenExpiry} /></span>
                  ) : (
                    <span className="hidden sm:inline">Authorize Upstox</span>
                  )}
                </>
              )}
            </Button>
            </motion.div>
          </div>

          <motion.div whileHover={{ scale: 1.1, rotate: 15 }} whileTap={{ scale: 0.9 }}>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className="apple-hover h-6 w-6 flex items-center justify-center rounded-full bg-transparent text-foreground/80 hover:bg-foreground hover:text-background transition-all"
          >
            {isLight ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
          </Button>
          </motion.div>
          
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground/70 px-1">
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

function IndexMetric({
  label,
  ltp,
  changePct,
  isVix,
  storeKey,
  onSelect,
}: {
  label: string;
  ltp: number | null | undefined;
  changePct?: number | null;
  isVix?: boolean;
  storeKey?: string;
  onSelect?: () => void;
}) {
  const [liveLtp, setLiveLtp] = useState(ltp);
  const [livePct, setLivePct] = useState(changePct);

  useEffect(() => {
    if (!storeKey) return;
    let prevTick: unknown = null;
    const unsub = useStore.subscribe((state) => {
      const tick = state.indices[storeKey];
      if (!tick || tick === prevTick) return;
      prevTick = tick;
      if (tick.ltp != null) setLiveLtp(tick.ltp);
      if (!isVix && tick.changePct != null) setLivePct(tick.changePct);
    });
    return unsub;
  }, [storeKey, isVix]);

  const tone = livePct == null ? "text-foreground/70" : livePct >= 0 ? "text-bull" : "text-bear";
  
  return (
    <button 
      type="button" 
      onClick={onSelect} 
      className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap cursor-pointer hover:bg-foreground/5 px-1.5 py-0.5 rounded transition-colors"
    >
      <span className="text-foreground/70">{label}</span>
      <strong className="text-foreground">
        <AnimatedNumber 
          value={liveLtp ?? ltp} 
          decimals={2} 
          duration={0.3}
          flashColor={true}
        />
      </strong>
      {!isVix && livePct != null && (
        <strong className={cn(tone)}>
          <AnimatedNumber 
            value={livePct} 
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
  return <span className="opacity-80">{timeLeft}</span>;
}
