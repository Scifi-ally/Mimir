import { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import { Wallet, Activity, History, RotateCcw, TrendingUp, TrendingDown, X, Shield } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { Variants } from "framer-motion";
import { cn, fmtNum } from "@/lib/format";
import { useStore } from "@/store/useStore";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.1,
    }
  }
};

const staggerItem: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.97, filter: "blur(4px)" },
  show: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", transition: { type: "spring", stiffness: 260, damping: 24, mass: 0.8 } }
};

import type { PaperAccount, PaperPosition } from "@/types/api";

export function PaperTradingPanel({ isOpen, onClose }: { isOpen?: boolean; onClose?: () => void }) {
  const [activeTab, setActiveTab] = useState<"positions" | "history">("positions");
  const showIsland = useStore((s) => s.showIsland);
  const queryClient = useQueryClient();

  const { data: accountData } = useQuery({
    queryKey: ["paperTrading", "account"],
    queryFn: api.paperTrading.account,
    enabled: isOpen,
    refetchInterval: 5000,
  });

  const { data: positionsData } = useQuery({
    queryKey: ["paperTrading", "positions"],
    queryFn: api.paperTrading.positions,
    enabled: isOpen,
    refetchInterval: 5000,
  });

  const { data: historyData } = useQuery({
    queryKey: ["paperTrading", "history"],
    queryFn: api.paperTrading.history,
    enabled: isOpen,
    refetchInterval: 5000,
  });

  const account = accountData || null;
  const positions = positionsData || [];
  const history = historyData || [];

  const handleReset = () => {
    showIsland({
      icon: <RotateCcw className="w-6 h-6" />,
      title: "Reset Paper Account?",
      subtitle: "All positions and history will be permanently cleared. Starting balance will return to ₹10,000.",
      confirmText: "Reset",
      isDestructive: true,
      onConfirm: async () => {
        await api.paperTrading.reset();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["paperTrading", "account"] }),
          queryClient.invalidateQueries({ queryKey: ["paperTrading", "positions"] }),
          queryClient.invalidateQueries({ queryKey: ["paperTrading", "history"] }),
        ]);
      }
    });
  };

  const balance = parseFloat(account?.balance ?? "0");
  const startingBalance = parseFloat(account?.startingBalance ?? "0");
  const allocated = parseFloat(account?.allocatedMargin ?? "0");
  const available = balance - allocated;
  const livePnl = parseFloat(account?.livePnl ?? "0");
  const equity = parseFloat(account?.equity ?? "0");
  const totalReturn = startingBalance > 0 ? ((equity - startingBalance) / startingBalance) * 100 : 0;
  const isProfit = livePnl > 0;
  const isLoss = livePnl < 0;

  // Compute stats from history
  const stats = useMemo(() => {
    const wins = history.filter(h => parseFloat(h.realizedPnl) > 0);
    const losses = history.filter(h => parseFloat(h.realizedPnl) < 0);
    const totalRealizedPnl = history.reduce((sum, h) => sum + parseFloat(h.realizedPnl), 0);
    const winRate = history.length > 0 ? (wins.length / history.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, w) => s + parseFloat(w.realizedPnl), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, l) => s + parseFloat(l.realizedPnl), 0) / losses.length) : 0;
    const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;
    return { wins: wins.length, losses: losses.length, totalRealizedPnl, winRate, avgWin, avgLoss, profitFactor };
  }, [history]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Background Dim */}
          <motion.div 
            initial={{ opacity: 0, backdropFilter: "blur(0px)" }} 
            animate={{ opacity: 1, backdropFilter: "blur(4px)" }} 
            exit={{ opacity: 0, backdropFilter: "blur(0px)" }} 
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="fixed inset-0 z-[60] bg-black/40"
            onClick={onClose}
          />

          {/* Main Panel */}
          <motion.div 
            initial={{ y: "100%", x: "-50%", scale: 0.95 }}
            animate={{ y: 0, x: "-50%", scale: 1 }}
            exit={{ y: "100%", x: "-50%", scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 30, mass: 0.8 }}
            className="fixed left-1/2 bottom-0 z-[70] flex flex-col bg-background/95 backdrop-blur-md saturate-150 ring-1 ring-white/10 text-foreground overflow-hidden h-[85vh] w-full max-w-4xl rounded-t-3xl shadow-[0_-8px_40px_-12px_rgba(0,0,0,0.5)]"
          >
            {/* Header */}
            <div className="flex justify-between items-center px-8 pt-6 pb-4 border-b border-border/5 shrink-0">
              <div className="flex flex-col">
                <h2 className="text-lg font-bold tracking-tight flex items-center gap-2 text-foreground">
                  <Wallet className="w-4 h-4 text-foreground/80" strokeWidth={2.5} />
                  Paper Trading
                </h2>
                <p className="text-foreground/40 text-[9px] mt-0.5 tracking-widest uppercase font-semibold">
                  Simulated Portfolio · Starting ₹{fmtNum(startingBalance, 0)}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleReset}
                  className="apple-hover text-[10px] font-bold tracking-widest uppercase flex items-center gap-1.5 hover:bg-destructive/10 text-foreground/40 hover:text-destructive px-3 py-1.5 rounded-lg transition-all duration-300"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset
                </button>
                <button 
                  onClick={onClose}
                  className="apple-hover p-2 rounded-full hover:bg-foreground/10 text-foreground/50 hover:text-foreground transition-all duration-300"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {!account ? (
              <div className="flex-1 flex flex-col items-center justify-center opacity-60">
                <div className="flex flex-col items-center gap-4 text-foreground/40 animate-pulse">
                  <Activity className="w-8 h-8" />
                  <div className="text-xs font-bold tracking-widest uppercase">Syncing Virtual Ledger...</div>
                </div>
              </div>
            ) : (
              <>
            {/* Account Metrics — Hero Row */}
            <motion.div variants={staggerContainer} initial="hidden" animate="show" className="px-8 py-5 border-b border-border/5 shrink-0">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
                {/* Equity — Hero metric */}
                <motion.div variants={staggerItem} className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase">Equity</span>
                  <span className="text-2xl font-mono tabular-nums font-bold tracking-tight text-foreground">
                    ₹{fmtNum(equity, 2)}
                  </span>
                  <span className={cn(
                    "text-[10px] font-mono tabular-nums font-bold",
                    totalReturn > 0 ? "text-bull" : totalReturn < 0 ? "text-bear" : "text-foreground/40"
                  )}>
                    {totalReturn > 0 ? '+' : ''}{totalReturn.toFixed(2)}% return
                  </span>
                </motion.div>

                {/* Available Margin */}
                <motion.div variants={staggerItem} className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase">Available</span>
                  <span className="text-2xl font-mono tabular-nums font-bold tracking-tight text-foreground/80">
                    ₹{fmtNum(available, 2)}
                  </span>
                </motion.div>

                {/* Allocated */}
                <motion.div variants={staggerItem} className="flex flex-col gap-1 min-w-0">
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase flex items-center justify-between">
                    <span>Deployed</span>
                    <span>{balance > 0 ? ((allocated / balance) * 100).toFixed(0) : 0}%</span>
                  </span>
                  <span className="text-2xl font-mono tabular-nums font-bold tracking-tight text-foreground/40">
                    ₹{fmtNum(allocated, 2)}
                  </span>
                  <div className="h-1 w-full bg-border/10 rounded-full overflow-hidden mt-1">
                    <motion.div 
                      className="h-full bg-accent rounded-full" 
                      initial={{ width: 0 }} 
                      animate={{ width: `${Math.min(100, Math.max(0, balance > 0 ? (allocated / balance) * 100 : 0))}%` }} 
                      transition={{ duration: 1, ease: "easeOut" }}
                    />
                  </div>
                </motion.div>

                {/* Live PnL */}
                <motion.div variants={staggerItem} className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase">Unrealized</span>
                  <span className={cn("text-2xl font-mono tabular-nums font-bold tracking-tight flex items-center gap-2", isProfit ? "text-bull" : isLoss ? "text-bear" : "text-foreground/40")}>
                    {isProfit ? <TrendingUp className="w-4 h-4" /> : isLoss ? <TrendingDown className="w-4 h-4" /> : null}
                    {livePnl >= 0 ? '+' : ''}₹{fmtNum(Math.abs(livePnl), 2)}
                  </span>
                </motion.div>

                {/* Win Rate */}
                <motion.div variants={staggerItem} className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase">Win Rate</span>
                  <span className={cn("text-2xl font-mono tabular-nums font-bold tracking-tight", stats.winRate >= 50 ? "text-bull" : stats.winRate > 0 ? "text-bear" : "text-foreground/40")}>
                    {history.length > 0 ? `${stats.winRate.toFixed(0)}%` : '—'}
                  </span>
                  {history.length > 0 && (
                    <span className="text-[10px] font-mono tabular-nums font-bold text-foreground/30">
                      {stats.wins}W / {stats.losses}L
                    </span>
                  )}
                </motion.div>
              </div>
            </motion.div>

            {/* Tabs */}
            <div className="flex px-8 pt-3 gap-8 border-b border-border/5 relative shrink-0">
              <button
                onClick={() => setActiveTab("positions")}
                className={cn(
                  "pb-3 text-xs font-bold tracking-widest uppercase flex items-center gap-2 transition-all duration-300 relative",
                  activeTab === "positions" ? "text-foreground" : "text-foreground/40 hover:text-foreground/70"
                )}
              >
                <Activity className="w-4 h-4" /> Open ({positions.length})
                {activeTab === "positions" && (
                  <motion.div layoutId="paperTradingTabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-foreground rounded-full" transition={{ type: "spring", stiffness: 400, damping: 30 }} />
                )}
              </button>
              <button
                onClick={() => setActiveTab("history")}
                className={cn(
                  "pb-3 text-xs font-bold tracking-widest uppercase flex items-center gap-2 transition-all duration-300 relative",
                  activeTab === "history" ? "text-foreground" : "text-foreground/40 hover:text-foreground/70"
                )}
              >
                <History className="w-4 h-4" /> History ({history.length})
                {activeTab === "history" && (
                  <motion.div layoutId="paperTradingTabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-foreground rounded-full" transition={{ type: "spring", stiffness: 400, damping: 30 }} />
                )}
              </button>
            </div>

            {/* Tab Content */}
            <div className="px-8 pb-8 pt-3 flex-1 overflow-y-auto">
              <AnimatePresence mode="wait">
                {activeTab === "positions" ? (
                  <motion.div 
                    key="positions"
                    variants={staggerContainer} 
                    initial="hidden" 
                    animate="show" 
                    exit="hidden"
                    className="flex flex-col"
                  >
                    {positions.length === 0 ? (
                      <motion.div variants={staggerItem} className="flex flex-col items-center justify-center py-16 text-foreground/30">
                        <Shield className="w-10 h-10 mb-3 opacity-30" strokeWidth={1} />
                        <p className="text-sm font-medium tracking-wide">No open positions</p>
                        <p className="text-xs text-foreground/20 mt-1">Trades are opened automatically from signal suggestions.</p>
                      </motion.div>
                    ) : (
                      positions.map(pos => (
                        <PositionRow key={pos.id} pos={pos} />
                      ))
                    )}
                  </motion.div>
                ) : (
                  <motion.div 
                    key="history"
                    variants={staggerContainer} 
                    initial="hidden" 
                    animate="show" 
                    exit="hidden"
                    className="flex flex-col"
                  >
                    {/* History Summary Bar */}
                    {history.length > 0 && (
                      <motion.div variants={staggerItem} className="flex flex-wrap gap-6 py-3 mb-2 text-[11px] font-mono text-foreground/50 border-b border-border/5">
                        <span>Realized PnL: <span className={cn("font-bold", stats.totalRealizedPnl >= 0 ? "text-bull" : "text-bear")}>{stats.totalRealizedPnl >= 0 ? '+' : ''}₹{fmtNum(Math.abs(stats.totalRealizedPnl), 2)}</span></span>
                        <span>Avg Win: <span className="font-bold text-bull">₹{fmtNum(stats.avgWin, 0)}</span></span>
                        <span>Avg Loss: <span className="font-bold text-bear">₹{fmtNum(stats.avgLoss, 0)}</span></span>
                        {stats.profitFactor !== Infinity && stats.profitFactor > 0 && (
                          <span>Profit Factor: <span className="font-bold text-foreground/80">{stats.profitFactor.toFixed(2)}</span></span>
                        )}
                      </motion.div>
                    )}
                    {history.length === 0 ? (
                      <motion.div variants={staggerItem} className="flex flex-col items-center justify-center py-16 text-foreground/30">
                        <History className="w-10 h-10 mb-3 opacity-30" strokeWidth={1} />
                        <p className="text-sm font-medium tracking-wide">No completed trades yet</p>
                        <p className="text-xs text-foreground/20 mt-1">Closed positions will appear here.</p>
                      </motion.div>
                    ) : (
                      history.map(hist => (
                        <HistoryRow key={hist.id} hist={hist} />
                      ))
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ─── Sub-components ────────────────────────────────────────────── */

function PositionRow({ pos }: { pos: PaperPosition }) {
  const pnl = parseFloat(pos.unrealizedPnl);
  const entry = parseFloat(pos.avgEntryPrice);
  const pnlPct = entry > 0 ? (pnl / (entry * pos.quantity)) * 100 : 0;
  const isProfit = pnl > 0;
  const isLoss = pnl < 0;

  return (
    <motion.div 
      variants={staggerItem} 
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 px-4 -mx-4 group hover:bg-foreground/[0.03] active:bg-foreground/[0.06] transition-all duration-300 rounded-lg"
    >
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-3">
          <span className="font-bold text-base text-foreground tracking-tight">{pos.symbol}</span>
          <span className={cn(
            "text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded",
            pos.direction === "BUY" ? "text-bull bg-bull/10" : "text-bear bg-bear/10"
          )}>
            {pos.direction}
          </span>
          <span className="text-[9px] font-bold tracking-widest uppercase text-accent px-1.5 py-0.5 rounded bg-accent/10">
            OPEN
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] font-mono font-medium text-foreground/50">
          <span className="flex items-center gap-1.5">
            QTY <span className="text-foreground/90">{pos.quantity}</span>
          </span>
          <span className="flex items-center gap-1.5">
            ENTRY <span className="text-foreground/90">₹{fmtNum(entry, 2)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            VALUE <span className="text-foreground/70">₹{fmtNum(entry * pos.quantity, 0)}</span>
          </span>
          {pos.trailingStopLoss && (
            <span className="flex items-center gap-1.5 text-accent">
              TSL <span className="font-bold">₹{fmtNum(parseFloat(pos.trailingStopLoss), 2)}</span>
            </span>
          )}
          <span className="text-foreground/30">
            {new Date(pos.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span className={cn("text-sm font-mono font-bold tabular-nums", isProfit ? "text-bull" : isLoss ? "text-bear" : "text-foreground/40")}>
          {pnl >= 0 ? "+" : ""}₹{fmtNum(Math.abs(pnl), 2)}
        </span>
        <span className={cn("text-[10px] font-mono font-bold", isProfit ? "text-bull/70" : isLoss ? "text-bear/70" : "text-foreground/30")}>
          {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
        </span>
      </div>
    </motion.div>
  );
}

function HistoryRow({ hist }: { hist: PaperPosition }) {
  const pnl = parseFloat(hist.realizedPnl);
  const entry = parseFloat(hist.avgEntryPrice);
  const pnlPct = entry > 0 ? (pnl / (entry * hist.quantity)) * 100 : 0;
  const isProfit = pnl > 0;
  const isLoss = pnl < 0;

  return (
    <motion.div 
      variants={staggerItem} 
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 px-4 -mx-4 group hover:bg-foreground/[0.03] transition-all duration-300 rounded-lg"
    >
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-3">
          <span className="font-bold text-base text-foreground tracking-tight">{hist.symbol}</span>
          <span className={cn(
            "text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded",
            hist.direction === "BUY" ? "text-bull bg-bull/10" : "text-bear bg-bear/10"
          )}>
            {hist.direction}
          </span>
          <span className={cn(
            "text-[9px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded",
            isProfit ? "text-bull/70 bg-bull/5" : "text-bear/70 bg-bear/5"
          )}>
            {isProfit ? "TARGET HIT" : "STOP HIT"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] font-mono font-medium text-foreground/50">
          <span className="flex items-center gap-1.5">
            QTY <span className="text-foreground/90">{hist.quantity}</span>
          </span>
          <span className="flex items-center gap-1.5">
            ENTRY <span className="text-foreground/90">₹{fmtNum(entry, 2)}</span>
          </span>
          {hist.closedAt && (
            <span className="flex items-center gap-1.5 text-foreground/30">
              {new Date(hist.closedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} {new Date(hist.closedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              <span className="w-1 h-1 rounded-full bg-foreground/20" />
              <span className="text-foreground/50">{formatDuration(new Date(hist.createdAt), new Date(hist.closedAt))}</span>
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span className={cn("text-sm font-mono font-bold tabular-nums", isProfit ? "text-bull" : isLoss ? "text-bear" : "text-foreground/40")}>
          {pnl >= 0 ? "+" : ""}₹{fmtNum(Math.abs(pnl), 2)}
        </span>
        <span className={cn("text-[10px] font-mono font-bold", isProfit ? "text-bull/70" : isLoss ? "text-bear/70" : "text-foreground/30")}>
          {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
        </span>
      </div>
    </motion.div>
  );
}

function formatDuration(start: Date, end: Date) {
  const diffMs = end.getTime() - start.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;
  const hrs = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return `${hrs}h ${mins}m`;
}
