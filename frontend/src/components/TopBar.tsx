import { KeyRound, Moon, Sun, Play, BarChart2, Wallet, Plus, Loader2, FileText } from "lucide-react";
import { useState, useEffect, useRef, memo } from "react";
import { motion } from "framer-motion";
import { flushSync } from "react-dom";
import { cn, fmtNum, fmtPct } from "@/lib/format";
import { Button } from "@/components/mimir/button";
import type { DashboardIndices, SystemStatus } from "@/types/api";
import { useStore } from "@/store/useStore";

interface TopBarProps {
  indices: DashboardIndices | null;
  status: SystemStatus | undefined;
  wsConnected: boolean;
  onAuthorize: () => void;
  authorizing: boolean;
  watchlistDate?: string | null;

  activeSignals: number;
  scanning?: boolean;
  scanProgress?: number;
  onOpenSuggestions: () => void;
  onOpenPaperTrading: () => void;
  onOpenReports: () => void;
  onSelectSymbol?: (symbol: string) => void;
}

import { api } from "@/lib/api";

export const TopBar = memo(function TopBar({
  indices,
  status,
  wsConnected,
  onAuthorize,
  authorizing,
  watchlistDate,
  activeSignals,
  scanning,
  scanProgress,
  onOpenSuggestions,
  onOpenPaperTrading,
  onOpenReports,
  onSelectSymbol,
}: TopBarProps) {

  const [isLight, setIsLight] = useState(false);
  const [startingScan, setStartingScan] = useState(false);
  const [stoppingScan, setStoppingScan] = useState(false);

  const showIsland = useStore((s) => s.showIsland);

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
    } catch (err) {
      setStartingScan(false);
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
          duration: 600,
          easing: "ease-in-out",
          pseudoElement: "::view-transition-new(root)",
          fill: "both",
        }
      );
    });
  };

  return (
    <>
      <header 
        className={cn(
          "sticky top-0 z-50 flex shrink-0 flex-col justify-center bg-background/90 backdrop-blur-md border-0 px-4 sm:px-6 py-2"
        )}
      >
        <div className="flex flex-col w-full gap-2">
          {/* Top Row: Core Indices & Actions */}
          <div className="flex w-full items-center justify-between gap-4 sm:gap-6 whitespace-nowrap pb-1">
            <div className="flex shrink-0 items-center gap-x-4 pr-2 py-1 relative">

          <div className="hidden sm:flex shrink-0 items-center gap-4 text-[11px] font-medium text-foreground/70">
            <IndexMetric label="NIFTY 50" ltp={indices?.nifty50.ltp} changePct={indices?.nifty50.changePct} storeKey="nifty" onSelect={() => onSelectSymbol?.("NIFTY 50")} />
            <IndexMetric label="SENSEX" ltp={indices?.sensex.ltp} changePct={indices?.sensex.changePct} storeKey="sensex" onSelect={() => onSelectSymbol?.("SENSEX")} />
            <IndexMetric label="BANK NIFTY" ltp={indices?.bankNifty.ltp} changePct={indices?.bankNifty.changePct} storeKey="banknifty" onSelect={() => onSelectSymbol?.("BANKNIFTY")} />
            <IndexMetric label="FIN NIFTY" ltp={indices?.finnifty.ltp} changePct={indices?.finnifty.changePct} storeKey="finnifty" onSelect={() => onSelectSymbol?.("FINNIFTY")} />
            <IndexMetric label="INDIA VIX" ltp={indices?.indiaVix.ltp} isVix storeKey="vix" onSelect={() => onSelectSymbol?.("INDIA VIX")} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          <div className="flex shrink-0 items-center gap-3 text-[11px] text-foreground/70">
            {indices?.fiiDiiDivergence && indices.fiiDiiDivergence.isDiverging && (
              <span 
                className={cn(
                  "px-2 py-0.5 rounded-full font-bold uppercase tracking-wider text-[9px] border",
                  indices.fiiDiiDivergence.divergenceType === "BULLISH" 
                    ? "bg-bull/10 text-bull border-bull/20" 
                    : "bg-bear/10 text-bear border-bear/20"
                )}
                title={`5D Net Flow: ₹${Math.round(indices.fiiDiiDivergence.totalFlow5d)}Cr | Nifty: ${indices.fiiDiiDivergence.niftyReturn5d.toFixed(1)}%`}
              >
                {indices.fiiDiiDivergence.divergenceType === "BULLISH" ? "Inst. Buy Divergence" : "Inst. Sell Divergence"}
              </span>
            )}
            <span className="truncate">
              <span className="hidden sm:inline">{watchlistDate}</span>
            </span>
            {activeSignals > 0 && !scanning && (
              <span className="font-semibold text-bull whitespace-nowrap">
                {activeSignals} active signals
              </span>
            )}
            {scanning && (
              <span className="font-semibold text-accent animate-pulse whitespace-nowrap">
                Scanning market...
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="outline"
              size="sm"
              onClick={handleScanButtonClick}
              disabled={startingScan || stoppingScan}
              className={cn(
                "apple-hover relative overflow-hidden h-6 text-[10px] px-2.5 font-medium border-foreground/20 bg-transparent transition-all duration-300",
                scanning 
                  ? "text-foreground hover:bg-red-500/10 hover:border-red-500/50 hover:text-red-500" 
                  : "text-foreground/80 hover:bg-foreground hover:text-background"
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
                    {scanProgress > 0 && scanProgress < 100 ? scanProgress.toFixed(1) : Math.round(scanProgress || 0)}%
                  </span>
                ) : (
                  <Play className={cn("h-4 w-4", startingScan && "animate-pulse text-bull")} />
                )}
              </span>
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenSuggestions}
              className="apple-hover h-6 flex items-center gap-1 text-[10px] px-2.5 font-medium border-foreground/20 bg-transparent text-foreground/80 hover:bg-foreground hover:text-background transition-all duration-300"
              title="View Performance Suggestions"
            >
              <BarChart2 className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Performance</span>
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="outline"
              size="icon"
              onClick={() => useStore.getState().setCommandPaletteOpen(true, "scan ")}
              className="apple-hover h-6 w-6 p-0 flex items-center justify-center border-foreground/20 bg-transparent text-foreground/80 hover:bg-foreground hover:text-background transition-all duration-300 rounded-md"
              title="Add Custom Screener Condition"
            >
              <Plus className="h-4 w-4" />
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="outline"
              size="icon"
              onClick={onOpenReports}
              className="apple-hover h-6 w-6 p-0 flex items-center justify-center border-foreground/20 bg-transparent text-foreground/80 hover:bg-foreground hover:text-background transition-all duration-300 rounded-md"
              title="Open Daily Reports"
            >
              <FileText className="h-4 w-4" />
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="outline"
              size="icon"
              onClick={onOpenPaperTrading}
              className="apple-hover h-6 w-6 p-0 flex items-center justify-center border-foreground/20 bg-transparent text-foreground/80 hover:bg-foreground hover:text-background transition-all duration-300 rounded-md"
              title="Open Paper Trading"
            >
              <Wallet className="h-4 w-4" />
            </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="outline"
              size="sm"
              onClick={onAuthorize}
              disabled={authorizing || status?.upstoxAuthenticated}
              className={cn(
                "apple-hover h-6 flex items-center gap-1.5 text-[10px] px-2.5 font-medium transition-all",
                !status?.upstoxAuthenticated
                  ? "border-red-500 text-red-500 hover:bg-red-500 hover:text-white"
                  : "border-foreground/20 bg-transparent text-foreground/80 hover:bg-foreground hover:text-background"
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
            <span className={cn("h-1.5 w-1.5 rounded-full", wsConnected ? "bg-bull animate-pulse-dot" : "bg-bear")} />
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
  const priceRef = useRef<HTMLElement>(null);
  const pctRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let prevTick: unknown = null;
    const unsub = useStore.subscribe((state) => {
      const tick = state.indices[storeKey!];
      if (!tick || tick === prevTick) return;
      prevTick = tick;
        if (priceRef.current && tick.ltp != null) {
          priceRef.current.textContent = fmtNum(tick.ltp, 2);
        }
        if (pctRef.current && !isVix && tick.changePct != null) {
          pctRef.current.textContent = fmtPct(tick.changePct);
          pctRef.current.className = cn("tabular-nums", tick.changePct >= 0 ? "text-bull" : "text-bear");
        }
      }
    );
    return unsub;
  }, [storeKey, isVix]);

  const tone = changePct == null ? "text-foreground/70" : changePct >= 0 ? "text-bull" : "text-bear";
  return (
    <button type="button" onClick={onSelect} className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap cursor-pointer hover:bg-foreground/5 px-1.5 py-0.5 rounded transition-colors">
      <span className="text-foreground/70">{label}</span>
      <strong ref={priceRef} className="text-foreground tabular-nums">
        {ltp != null ? fmtNum(ltp, 2) : "—"}
      </strong>
      {!isVix && (
        <strong ref={pctRef} className={cn(tone, "tabular-nums")}>
          {changePct != null ? fmtPct(changePct) : ""}
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
