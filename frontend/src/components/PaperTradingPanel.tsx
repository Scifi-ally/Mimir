import { useState, useMemo } from "react";
import { api } from "@/lib/api";
import { Wallet, Activity, History, RotateCcw, TrendingUp, TrendingDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { Variants } from "framer-motion";
import { cn, fmtNum, toFixed, toFixedPct } from "@/lib/format";
import { useStore } from "@/store/useStore";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatedNumber } from "@/components/atoms/AnimatedNumber";

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

import type { PaperPosition } from "@/types/api";
import { FADE_FAST, FADE_SLOW, SPRING_STANDARD } from "@/lib/motion";

const EMPTY_POSITIONS: PaperPosition[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EMPTY_HISTORY: any[] = [];

export function PaperTradingPanel({ isOpen, onClose }: { isOpen?: boolean; onClose?: () => void }) {
  const [activeTab, setActiveTab] = useState<"positions" | "history">("positions");
  const showIsland = useStore((s) => s.showIsland);
  const queryClient = useQueryClient();

  // Mode drives the whole panel: PAPER shows the simulated ledger,
  // LIVE swaps in real broker positions/funds/orders.
  const { data: modeData } = useQuery({
    queryKey: ["trading-mode"],
    queryFn: api.tradingMode,
    enabled: isOpen,
    refetchInterval: 15000,
  });
  const isLive = modeData?.mode === "LIVE";

  // WS position_update invalidates ["paperTrading"] instantly; polling is only
  // a slow safety net now.
  const { data: accountData } = useQuery({
    queryKey: ["paperTrading", "account"],
    queryFn: api.paperTrading.account,
    enabled: isOpen,
    refetchInterval: 30000,
  });

  const { data: positionsData } = useQuery({
    queryKey: ["paperTrading", "positions"],
    queryFn: api.paperTrading.positions,
    enabled: isOpen,
    refetchInterval: 30000,
  });

  const { data: historyData } = useQuery({
    queryKey: ["paperTrading", "history"],
    queryFn: api.paperTrading.history,
    enabled: isOpen,
    refetchInterval: 30000,
  });

  // LIVE-mode data (only fetched when armed)
  const { data: brokerFunds } = useQuery({
    queryKey: ["live", "funds"],
    queryFn: api.liveBrokerFunds,
    enabled: !!isOpen && isLive,
    refetchInterval: 10000,
    retry: false,
  });

  const { data: brokerPositions } = useQuery({
    queryKey: ["live", "positions"],
    queryFn: api.liveBrokerPositions,
    enabled: !!isOpen && isLive,
    refetchInterval: 5000,
    retry: false,
  });

  const { data: liveOrders } = useQuery({
    queryKey: ["live", "orders"],
    queryFn: () => api.liveOrders(50),
    enabled: !!isOpen && isLive,
    refetchInterval: 10000,
    retry: false,
  });

  const account = accountData || null;
  const positions = positionsData || EMPTY_POSITIONS;
  const history = historyData || EMPTY_HISTORY;

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

  const balance = Number(account?.balance ?? 0);
  const startingBalance = Number(account?.startingBalance ?? 0);
  const allocated = Number(account?.allocatedMargin ?? 0);
  const available = balance - allocated;
  const livePnl = Number(account?.livePnl ?? 0);
  const equity = Number(account?.equity ?? 0);
  const totalReturn = startingBalance > 0 ? ((equity - startingBalance) / startingBalance) * 100 : 0;
  const isProfit = livePnl > 0;
  const isLoss = livePnl < 0;
  const liveDayPnl = useMemo(
    () => (brokerPositions ?? []).reduce((sum, p) => sum + (Number.isFinite(p.pnl) ? p.pnl : 0), 0),
    [brokerPositions],
  );

  // Compute stats from history
  const stats = useMemo(() => {
    const wins = history.filter(h => Number(h.realizedPnl) > 0);
    const losses = history.filter(h => Number(h.realizedPnl) < 0);
    const totalRealizedPnl = history.reduce((sum, h) => sum + Number(h.realizedPnl), 0);
    const winRate = history.length > 0 ? (wins.length / history.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, w) => s + Number(w.realizedPnl), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, l) => s + Number(l.realizedPnl), 0) / losses.length) : 0;
    // True profit factor = gross profit / gross loss (avgWin/avgLoss is the payoff ratio, not PF)
    const grossWin = wins.reduce((s, w) => s + Number(w.realizedPnl), 0);
    const grossLoss = Math.abs(losses.reduce((s, l) => s + Number(l.realizedPnl), 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    return { wins: wins.length, losses: losses.length, totalRealizedPnl, winRate, avgWin, avgLoss, profitFactor };
  }, [history]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Background Dim */}
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }} 
            transition={FADE_FAST}
            className="fixed inset-0 z-[60] bg-background/80"
            onClick={onClose}
          />

          {/* Main Panel */}
          <motion.div 
            initial={{ y: "100%", x: "-50%", scale: 0.96 }}
            animate={{ y: 0, x: "-50%", scale: 1 }}
            exit={{ y: "100%", x: "-50%", scale: 0.96 }}
            transition={FADE_SLOW}
            className="fixed left-1/2 bottom-0 z-[70] flex flex-col bg-background text-foreground overflow-hidden h-[85vh] w-full max-w-4xl rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.4)] ring-0 outline-none"
          >
            {/* Header */}
            <div className="flex justify-between items-center px-8 pt-6 pb-4 shrink-0">
              <div className="flex flex-col">
                <h2 className="text-lg font-bold tracking-tight flex items-center gap-2 text-foreground">
                  <Wallet className="w-4 h-4 text-foreground/80" strokeWidth={2.5} />
                  {isLive ? "Live Trading" : "Paper Trading"}
                  {isLive && (
                    <span className="flex items-center gap-1.5 ml-1 text-[9px] font-black tracking-widest text-destructive uppercase">
                      <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                      Real Orders
                    </span>
                  )}
                </h2>
                <p className="text-foreground/40 text-[9px] mt-0.5 tracking-widest uppercase font-semibold">
                  {isLive
                    ? `Broker Account · Available ₹${fmtNum(brokerFunds?.availableMargin ?? 0, 0)}`
                    : `Simulated Portfolio · Starting ₹${fmtNum(startingBalance, 0)}`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {!isLive && (
                  <button
                    onClick={handleReset}
                    className="apple-hover text-[10px] font-bold tracking-widest uppercase flex items-center gap-1.5 hover:bg-destructive/10 text-foreground/40 hover:text-destructive px-3 py-1.5 rounded-lg transition-all duration-300"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset
                  </button>
                )}
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
            {isLive ? (

            /* LIVE Account Metrics — real broker numbers */
            <motion.div variants={staggerContainer} initial="hidden" animate="show" className="px-6 sm:px-8 py-5 shrink-0">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
                <motion.div variants={staggerItem} className="flex flex-col gap-1 min-w-0 overflow-hidden">
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase truncate">Available Margin</span>
                  <span className="text-xl sm:text-2xl font-mono tabular-nums font-bold tracking-tight text-foreground truncate">
                    ₹{fmtNum(brokerFunds?.availableMargin ?? 0, 2)}
                  </span>
                </motion.div>
                <motion.div variants={staggerItem} className="flex flex-col gap-1 min-w-0 overflow-hidden">
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase truncate">Used Margin</span>
                  <span className="text-xl sm:text-2xl font-mono tabular-nums font-bold tracking-tight text-foreground/60 truncate">
                    ₹{fmtNum(brokerFunds?.usedMargin ?? 0, 2)}
                  </span>
                </motion.div>
                <motion.div variants={staggerItem} className="flex flex-col gap-1 min-w-0 overflow-hidden">
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase truncate">Day PnL</span>
                  <span className={cn(
                    "text-xl sm:text-2xl font-mono tabular-nums font-bold tracking-tight flex items-center gap-1.5 truncate",
                    liveDayPnl > 0 ? "text-bull" : liveDayPnl < 0 ? "text-bear" : "text-foreground/40"
                  )}>
                    {liveDayPnl > 0 ? <TrendingUp className="w-4 h-4 shrink-0" /> : liveDayPnl < 0 ? <TrendingDown className="w-4 h-4 shrink-0" /> : null}
                    {/* A loss must read as negative even in monochrome/screenshot/color-blind
                        contexts — never strip the minus sign. Positive gets '+', negative gets
                        '-₹', zero stays bare. */}
                    <span className="truncate">{liveDayPnl > 0 ? '+' : liveDayPnl < 0 ? '-' : ''}₹{fmtNum(Math.abs(liveDayPnl), 2)}</span>
                  </span>
                </motion.div>
                <motion.div variants={staggerItem} className="flex flex-col gap-1 min-w-0 overflow-hidden">
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase truncate">Open Positions</span>
                  <span className="text-xl sm:text-2xl font-mono tabular-nums font-bold tracking-tight text-foreground/80 truncate">
                    {brokerPositions?.filter(p => p.quantity !== 0).length ?? 0}
                  </span>
                </motion.div>
              </div>
            </motion.div>

            ) : (

            /* Account Metrics — Hero Row */
            <motion.div variants={staggerContainer} initial="hidden" animate="show" className="px-6 sm:px-8 py-5 shrink-0">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 sm:gap-6">
                {/* Equity — Hero metric */}
                <motion.div variants={staggerItem} className="flex flex-col gap-1 min-w-0 overflow-hidden" title={`₹${fmtNum(equity, 2)}`}>
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase truncate">Equity</span>
                  <span className="text-xl sm:text-2xl font-mono tabular-nums font-bold tracking-tight text-foreground truncate">
                    ₹{fmtNum(equity, 2)}
                  </span>
                  <span className={cn(
                    "text-[10px] font-mono tabular-nums font-bold truncate",
                    totalReturn > 0 ? "text-bull" : totalReturn < 0 ? "text-bear" : "text-foreground/40"
                  )}>
                    {totalReturn > 0 ? '+' : ''}{toFixed(totalReturn, 2)}% return
                  </span>
                </motion.div>

                {/* Available Margin */}
                <motion.div variants={staggerItem} className="flex flex-col gap-1 min-w-0 overflow-hidden" title={`₹${fmtNum(available, 2)}`}>
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase truncate">Available</span>
                  <span className="text-xl sm:text-2xl font-mono tabular-nums font-bold tracking-tight text-foreground/80 truncate">
                    ₹{fmtNum(available, 2)}
                  </span>
                </motion.div>

                {/* Allocated */}
                <motion.div variants={staggerItem} className="flex flex-col gap-1 min-w-0 overflow-hidden" title={`₹${fmtNum(allocated, 2)}`}>
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase flex items-center justify-between gap-1">
                    <span className="truncate">Deployed</span>
                    <span className="shrink-0">{balance > 0 ? toFixed((allocated / balance) * 100, 0) : 0}%</span>
                  </span>
                  <span className="text-xl sm:text-2xl font-mono tabular-nums font-bold tracking-tight text-foreground/40 truncate">
                    ₹{fmtNum(allocated, 2)}
                  </span>
                  <div className="h-1 w-full bg-border/10 rounded-full overflow-hidden mt-1 shrink-0">
                    <motion.div 
                      className="h-full bg-accent rounded-full" 
                      initial={{ width: 0 }} 
                      animate={{ width: `${Math.min(100, Math.max(0, balance > 0 ? (allocated / balance) * 100 : 0))}%` }} 
                      transition={{ duration: 1, ease: "easeOut" }}
                    />
                  </div>
                </motion.div>

                {/* Live PnL */}
                <motion.div variants={staggerItem} className="flex flex-col gap-1 min-w-0 overflow-hidden" title={`₹${fmtNum(Math.abs(livePnl), 2)}`}>
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase truncate">Unrealized</span>
                  <span className={cn("text-xl sm:text-2xl font-mono tabular-nums font-bold tracking-tight flex items-center gap-1.5 truncate", isProfit ? "text-bull" : isLoss ? "text-bear" : "text-foreground/40")}>
                    {isProfit ? <TrendingUp className="w-4 h-4 shrink-0" /> : isLoss ? <TrendingDown className="w-4 h-4 shrink-0" /> : null}
                    {/* A loss must read as negative even in monochrome/screenshot/color-blind
                        contexts — never strip the minus sign. Matches the LIVE Day PnL above. */}
                    <span className="truncate">{isProfit ? '+' : isLoss ? '-' : ''}₹{fmtNum(Math.abs(livePnl), 2)}</span>
                  </span>
                </motion.div>

                {/* Win Rate */}
                <motion.div variants={staggerItem} className="flex flex-col gap-1 min-w-0 overflow-hidden">
                  <span className="text-[10px] font-bold text-foreground/50 tracking-widest uppercase truncate">Win Rate</span>
                  <span className={cn("text-xl sm:text-2xl font-mono tabular-nums font-bold tracking-tight truncate", stats.winRate >= 50 ? "text-bull" : stats.winRate > 0 ? "text-bear" : "text-foreground/40")}>
                    {history.length > 0 ? `${toFixed(stats.winRate, 0)}%` : '—'}
                  </span>
                  {history.length > 0 && (
                    <span className="text-[10px] font-mono tabular-nums font-bold text-foreground/30 truncate">
                      {stats.wins}W / {stats.losses}L
                    </span>
                  )}
                </motion.div>
              </div>
            </motion.div>

            )}

            {/* Tabs */}
            <div className="flex px-8 pt-3 gap-8 relative shrink-0">
              <button
                onClick={() => setActiveTab("positions")}
                className={cn(
                  "pb-3 text-xs font-bold tracking-widest uppercase flex items-center gap-2 transition-all duration-300 relative",
                  activeTab === "positions" ? "text-foreground" : "text-foreground/40 hover:text-foreground/70"
                )}
              >
                <Activity className="w-4 h-4" /> Open ({isLive ? (brokerPositions?.filter(p => p.quantity !== 0).length ?? 0) : positions.length})
                {activeTab === "positions" && (
                  <motion.div layoutId="paperTradingTabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-foreground rounded-full" transition={SPRING_STANDARD} />
                )}
              </button>
              <button
                onClick={() => setActiveTab("history")}
                className={cn(
                  "pb-3 text-xs font-bold tracking-widest uppercase flex items-center gap-2 transition-all duration-300 relative",
                  activeTab === "history" ? "text-foreground" : "text-foreground/40 hover:text-foreground/70"
                )}
              >
                <History className="w-4 h-4" /> {isLive ? `Orders (${liveOrders?.length ?? 0})` : `History (${history.length})`}
                {activeTab === "history" && (
                  <motion.div layoutId="paperTradingTabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-foreground rounded-full" transition={SPRING_STANDARD} />
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
                    className="flex flex-col gap-2.5 pt-2"
                  >
                    {isLive ? (
                      (brokerPositions?.filter(p => p.quantity !== 0).length ?? 0) === 0 ? (
                        <motion.div variants={staggerItem} className="flex flex-col items-center justify-center py-16 text-foreground/30">
                          <p className="text-xs font-medium tracking-wide">No open broker positions</p>
                        </motion.div>
                      ) : (
                        brokerPositions!.filter(p => p.quantity !== 0).map(pos => (
                          <BrokerPositionRow key={`${pos.symbol}-${pos.product}`} pos={pos} />
                        ))
                      )
                    ) : positions.length === 0 ? (
                      <motion.div variants={staggerItem} className="flex flex-col items-center justify-center py-16 text-foreground/30">
                        <p className="text-xs font-medium tracking-wide">No open positions</p>
                      </motion.div>
                    ) : (
                      positions.map(pos => (
                        <PositionRow key={pos.id} pos={pos} />
                      ))
                    )}
                  </motion.div>
                ) : isLive ? (
                  <motion.div
                    key="live-orders"
                    variants={staggerContainer}
                    initial="hidden"
                    animate="show"
                    exit="hidden"
                    className="flex flex-col gap-2.5 pt-2"
                  >
                    {(liveOrders?.length ?? 0) === 0 ? (
                      <motion.div variants={staggerItem} className="flex flex-col items-center justify-center py-16 text-foreground/30">
                        <History className="w-10 h-10 mb-3 opacity-30" strokeWidth={1} />
                        <p className="text-sm font-medium tracking-wide">No live orders yet</p>
                        <p className="text-xs text-foreground/20 mt-1">Every real order placed at the broker is audited here.</p>
                      </motion.div>
                    ) : (
                      liveOrders!.map(order => (
                        <LiveOrderRow key={order.id} order={order} />
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
                    className="flex flex-col gap-2.5 pt-2"
                  >
                    {/* History Summary Bar */}
                    {history.length > 0 && (
                      <motion.div variants={staggerItem} className="flex flex-wrap gap-6 py-3 mb-2 text-[11px] font-mono text-foreground/50">
                        <span>Realized PnL: <span className={cn("font-bold", stats.totalRealizedPnl >= 0 ? "text-bull" : "text-bear")}>{stats.totalRealizedPnl >= 0 ? '+' : ''}₹{fmtNum(Math.abs(stats.totalRealizedPnl), 2)}</span></span>
                        <span>Avg Win: <span className="font-bold text-bull">₹{fmtNum(stats.avgWin, 0)}</span></span>
                        <span>Avg Loss: <span className="font-bold text-bear">₹{fmtNum(stats.avgLoss, 0)}</span></span>
                        {stats.profitFactor !== Infinity && stats.profitFactor > 0 && (
                          <span>Profit Factor: <span className="font-bold text-foreground/80">{toFixed(stats.profitFactor, 2)}</span></span>
                        )}
                      </motion.div>
                    )}
                    {history.length === 0 ? (
                      <motion.div variants={staggerItem} className="flex flex-col items-center justify-center py-16 text-foreground/30">
                        <p className="text-xs font-medium tracking-wide">No completed trades yet</p>
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

function BrokerPositionRow({ pos }: { pos: { symbol: string; quantity: number; avgPrice: number; lastPrice: number; pnl: number; product: string } }) {
  const isProfit = pos.pnl > 0;
  const isLoss = pos.pnl < 0;
  const isLong = pos.quantity > 0;
  const value = Math.abs(pos.quantity) * pos.avgPrice;
  const pnlPct = value > 0 ? (pos.pnl / value) * 100 : 0;

  return (
    <motion.div
      variants={staggerItem}
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-secondary/10 hover:bg-secondary/20 transition-all duration-300 rounded-xl group"
    >
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-3">
          <span className="font-bold text-base text-foreground tracking-tight">{pos.symbol}</span>
          <span className={cn(
            "text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded",
            isLong ? "text-bull bg-bull/10" : "text-bear bg-bear/10"
          )}>
            {isLong ? "LONG" : "SHORT"}
          </span>
          <span className="text-[9px] font-bold tracking-widest uppercase text-destructive px-1.5 py-0.5 rounded bg-destructive/10">
            LIVE
          </span>
          <span className="text-[9px] font-bold tracking-widest uppercase text-foreground/40">
            {pos.product === "I" ? "MIS" : pos.product === "D" ? "CNC" : pos.product}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] font-mono font-medium text-foreground/50">
          <span className="flex items-center gap-1.5">
            QTY <span className="text-foreground/90">{Math.abs(pos.quantity)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            AVG <span className="text-foreground/90">₹{fmtNum(pos.avgPrice, 2)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            LTP <span className="text-foreground/90">₹{fmtNum(pos.lastPrice, 2)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            VALUE <span className="text-foreground/70">₹{fmtNum(value, 0)}</span>
          </span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span className={cn("text-sm font-mono font-bold tabular-nums", isProfit ? "text-bull" : isLoss ? "text-bear" : "text-foreground/40")}>
          <AnimatedNumber value={pos.pnl} decimals={2} showSign={true} prefix="₹" duration={0.3} flashColor={true} />
        </span>
        <span className={cn("text-[10px] font-mono font-bold", isProfit ? "text-bull/70" : isLoss ? "text-bear/70" : "text-foreground/30")}>
          <AnimatedNumber value={pnlPct} decimals={2} showSign={true} suffix="%" duration={0.3} flashColor={true} />
        </span>
      </div>
    </motion.div>
  );
}

function LiveOrderRow({ order }: { order: { id: string; symbol: string; direction: string; orderType: string; quantity: number; price: string | null; status: string; statusMessage: string | null; brokerOrderId: string | null; placedAt: string } }) {
  const statusColor =
    order.status === "PLACED" ? "text-bull bg-bull/10"
    : order.status === "FAILED" || order.status === "REJECTED" ? "text-destructive bg-destructive/10"
    : order.status === "CANCELLED" ? "text-foreground/40 bg-foreground/5"
    : "text-amber-500 bg-amber-500/10";

  return (
    <motion.div
      variants={staggerItem}
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-secondary/10 hover:bg-secondary/20 transition-all duration-300 rounded-xl"
    >
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-3">
          <span className="font-bold text-base text-foreground tracking-tight">{order.symbol}</span>
          <span className={cn(
            "text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded",
            order.direction === "BUY" ? "text-bull bg-bull/10" : "text-bear bg-bear/10"
          )}>
            {order.direction}
          </span>
          <span className={cn("text-[9px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded", statusColor)}>
            {order.status}
          </span>
          <span className="text-[9px] font-bold tracking-widest uppercase text-foreground/40">
            {order.orderType.replace(/_/g, " ")}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] font-mono font-medium text-foreground/50">
          <span className="flex items-center gap-1.5">
            QTY <span className="text-foreground/90">{order.quantity}</span>
          </span>
          {order.price && (
            <span className="flex items-center gap-1.5">
              REF <span className="text-foreground/90">₹{fmtNum(Number(order.price), 2)}</span>
            </span>
          )}
          {order.brokerOrderId && (
            <span className="text-foreground/30 truncate max-w-[160px]" title={order.brokerOrderId}>
              #{order.brokerOrderId}
            </span>
          )}
          <span className="text-foreground/30">
            {new Date(order.placedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        {order.statusMessage && (
          <p className="text-[10px] text-destructive/80 font-mono">{order.statusMessage}</p>
        )}
      </div>
    </motion.div>
  );
}


function PositionRow({ pos }: { pos: PaperPosition }) {
  const pnl = Number(pos.unrealizedPnl);
  const entry = Number(pos.avgEntryPrice);
  const pnlPct = entry > 0 ? (pnl / (entry * pos.quantity)) * 100 : 0;
  const isProfit = pnl > 0;
  const isLoss = pnl < 0;

  return (
    <motion.div 
      variants={staggerItem} 
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-foreground/[0.03] hover:bg-foreground/[0.06] active:scale-[0.99] transition-all duration-300 rounded-xl group"
    >
      <div className="flex flex-col gap-2 min-w-0">
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
              TSL <span className="font-bold">₹{fmtNum(Number(pos.trailingStopLoss), 2)}</span>
            </span>
          )}
          <span className="text-foreground/30">
            {new Date(pos.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span className={cn("text-sm font-mono font-bold tabular-nums", isProfit ? "text-bull" : isLoss ? "text-bear" : "text-foreground/40")}>
          <AnimatedNumber value={pnl} decimals={2} showSign={true} prefix="₹" duration={0.3} flashColor={true} />
        </span>
        <span className={cn("text-[10px] font-mono font-bold", isProfit ? "text-bull/70" : isLoss ? "text-bear/70" : "text-foreground/30")}>
          <AnimatedNumber value={pnlPct} decimals={2} showSign={true} suffix="%" duration={0.3} flashColor={true} />
        </span>
      </div>
    </motion.div>
  );
}

function HistoryRow({ hist }: { hist: PaperPosition }) {
  const pnl = Number(hist.realizedPnl);
  const entry = Number(hist.avgEntryPrice);
  const pnlPct = entry > 0 ? (pnl / (entry * hist.quantity)) * 100 : 0;
  const isProfit = pnl > 0;
  const isLoss = pnl < 0;

  // Badge from the actual exit reason when the backend provides it; otherwise an
  // honest "CLOSED" — never claim TARGET/STOP from the P&L sign alone.
  const closeReason = (hist as PaperPosition & { closeReason?: string | null }).closeReason;
  const exitLabel =
    closeReason === "TARGET_EXIT" ? "TARGET HIT"
    : closeReason === "STOP_EXIT" ? (isProfit ? "TRAIL STOP" : "STOP HIT")
    : isProfit ? "CLOSED +" : isLoss ? "CLOSED −" : "CLOSED";

  return (
    <motion.div 
      variants={staggerItem} 
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-secondary/10 hover:bg-secondary/20 transition-all duration-300 rounded-xl group"
    >
      <div className="flex flex-col gap-2 min-w-0">
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
            isProfit ? "text-bull/70 bg-bull/5" : isLoss ? "text-bear/70 bg-bear/5" : "text-foreground/50 bg-foreground/5"
          )}>
            {exitLabel}
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
          {toFixedPct(pnlPct, 2)}
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
