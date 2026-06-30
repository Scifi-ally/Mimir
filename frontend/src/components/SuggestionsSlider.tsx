import { useState } from 'react';
import { X, Target, BarChart2, Activity, CheckCircle2, TrendingUp, Clock, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn, fmtNum, calcPnLPct } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { WatchlistItem } from '@/types/api';

type WatchlistSetup = {
  id: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  setupType: string;
  status: 'WATCHLIST';
  condition: WatchlistItem['condition'];
  currentPrice?: number | null;
  confidence: number;
};

type FilterTab = 'ALL' | 'ACTIVE' | 'WATCHLIST' | 'COMPLETED';

function getWatchlistScore(item: WatchlistItem, index: number): number {
  return item.compositeScore ?? (item.signalGenerated ? 90 : 80 + (index % 15));
}

export function SuggestionsSlider({ isOpen, onClose, onSelectSymbol }: { isOpen: boolean; onClose: () => void; onSelectSymbol?: (symbol: string) => void }) {
  const [activeTab, setActiveTab] = useState<FilterTab>('ALL');

  const { data: suggestions = [], isPending, error } = useQuery({
    queryKey: ['suggestions', 'today'],
    queryFn: () => api.todaySuggestions(),
    refetchInterval: isOpen ? 5000 : false,
    staleTime: 0,
    enabled: isOpen,
  });

  const { data: watchlist } = useQuery({
    queryKey: ['watchlist', 'today'],
    queryFn: () => api.watchlistToday(),
    refetchInterval: isOpen ? 5000 : false,
    staleTime: 0,
    enabled: isOpen,
  });

  const rawWatchlistSetups = (Array.isArray(watchlist) ? watchlist : watchlist ? [
    ...(watchlist.momentumCandidates || []),
    ...(watchlist.breakoutCandidates || []),
    ...(watchlist.gapCandidates || []),
    ...(watchlist.intradayCandidates || []),
  ] : []).map<WatchlistSetup>((item, idx) => ({
    id: `wl-${idx}-${item.symbol}`,
    symbol: item.symbol,
    direction: item.category?.toUpperCase().includes('BEAR') ? 'SELL' : 'BUY',
    setupType: item.category,
    status: 'WATCHLIST',
    condition: item.condition,
    currentPrice: item.ltp,
    confidence: getWatchlistScore(item, idx),
  }));

  const activeTrades = suggestions.filter(s => s.status === 'ACTIVE');
  const completedTrades = suggestions.filter(s => s.status === 'TARGET_1_HIT' || s.status === 'TARGET_2_HIT' || s.status === 'STOP_HIT');
  const winningTrades = completedTrades.filter(s => s.status.includes('TARGET'));
  const expiredTrades = suggestions.filter(s => s.status === 'EXPIRED');

  const winRate = completedTrades.length > 0 ? (winningTrades.length / completedTrades.length) * 100 : 0;
  const totalPnl = completedTrades.reduce((sum, s) => sum + (s.pnlInr ?? 0), 0);
  const avgRR = activeTrades.length > 0
    ? activeTrades.reduce((sum, s) => sum + (s.riskReward ?? 0), 0) / activeTrades.length
    : 0;

  const showActive = activeTab === 'ALL' || activeTab === 'ACTIVE';
  const showWatchlist = activeTab === 'ALL' || activeTab === 'WATCHLIST';
  const showCompleted = activeTab === 'ALL' || activeTab === 'COMPLETED';

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Modal Panel */}
          <motion.div 
            initial={{ y: "100%", x: "-50%" }}
            animate={{ y: 0, x: "-50%" }}
            exit={{ y: "100%", x: "-50%" }}
            transition={{ type: "spring", stiffness: 400, damping: 30, mass: 0.8 }}
            className="fixed left-1/2 bottom-0 z-[70] flex flex-col bg-card/95 backdrop-blur-2xl border-t border-x border-border/20 text-foreground overflow-hidden h-[86vh] w-full max-w-4xl rounded-t-3xl shadow-2xl"
          >
            {/* Header */}
            <div className="relative px-8 pr-12 pt-6 pb-4 flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0 border-b border-border/10">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
                  <Target className="w-5 h-5" strokeWidth={2.5} />
                </div>
                <div>
                  <h2 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
                    Performance & Signals
                  </h2>
                  <p className="text-muted-foreground text-xs mt-0.5 font-medium tracking-wide">
                    Live Intraday Action & Execution Stats
                  </p>
                </div>
              </div>

              {/* Clean Tabs */}
              <div className="flex items-center gap-5 mr-6">
                {(['ALL', 'ACTIVE', 'WATCHLIST', 'COMPLETED'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      "py-2 text-xs font-bold transition-all flex items-center gap-1.5 relative",
                      activeTab === tab
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground/80"
                    )}
                  >
                    {tab === 'ACTIVE' && <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />}
                    {tab === 'ALL' ? 'All Setups' : tab === 'ACTIVE' ? `Active (${activeTrades.length})` : tab === 'WATCHLIST' ? `Watchlist (${rawWatchlistSetups.length})` : `Closed (${completedTrades.length + expiredTrades.length})`}
                    {activeTab === tab && (
                      <motion.div layoutId="activeSuggestionTabIndicator" className="absolute -bottom-0.5 left-0 right-0 h-0.5 bg-primary" />
                    )}
                  </button>
                ))}
              </div>

              <button 
                onClick={onClose}
                className="absolute right-6 top-6 z-10 p-2 rounded-full hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-all duration-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Essential Stats Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 px-8 py-5 border-b border-border/5 shrink-0">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
                  <Zap className="w-3.5 h-3.5 text-bull" /> Live Active Signals
                </div>
                <div className="text-2xl font-mono font-bold tabular-nums text-foreground">
                  {activeTrades.length}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
                  <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Win Rate</span>
                  <span className="text-foreground">{winningTrades.length}W / {completedTrades.length - winningTrades.length}L</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className={cn("text-2xl font-mono font-bold tabular-nums", winRate >= 50 ? "text-bull" : completedTrades.length > 0 ? "text-bear" : "text-foreground")}>
                    {completedTrades.length > 0 ? `${winRate.toFixed(0)}%` : '—'}
                  </span>
                </div>
                {completedTrades.length > 0 && (
                  <div className="h-1.5 w-full bg-bear/20 rounded-full overflow-hidden mt-1">
                    <div className="h-full bg-bull rounded-full transition-all duration-500" style={{ width: `${winRate}%` }} />
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
                  <TrendingUp className="w-3.5 h-3.5" /> Realized P&L
                </div>
                <div className={cn("text-2xl font-mono font-bold tabular-nums", totalPnl > 0 ? "text-bull" : totalPnl < 0 ? "text-bear" : "text-foreground")}>
                  {totalPnl >= 0 && totalPnl > 0 ? '+' : ''}₹{Math.abs(totalPnl).toFixed(0)}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
                  <BarChart2 className="w-3.5 h-3.5" /> Avg Active R:R
                </div>
                <div className="text-2xl font-mono font-bold tabular-nums text-foreground">
                  {avgRR > 0 ? `${avgRR.toFixed(1)}x` : '—'}
                </div>
              </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-8 flex flex-col gap-8">
              {isPending ? (
                <div className="flex-1 flex items-center justify-center py-20">
                  <div className="animate-pulse flex gap-2 items-center text-muted-foreground">
                    <div className="w-2.5 h-2.5 rounded-full bg-primary animate-bounce" />
                    <div className="w-2.5 h-2.5 rounded-full bg-primary animate-bounce delay-100" />
                    <div className="w-2.5 h-2.5 rounded-full bg-primary animate-bounce delay-200" />
                  </div>
                </div>
              ) : error ? (
                <div className="flex-1 flex items-center justify-center py-20 text-destructive text-sm font-semibold">
                  {error instanceof Error ? error.message : "Failed to load signals"}
                </div>
              ) : activeTrades.length === 0 && rawWatchlistSetups.length === 0 && completedTrades.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <Activity className="w-14 h-14 mb-3 opacity-30" strokeWidth={1.5} />
                  <p className="text-base font-semibold text-foreground">No signals active or generated right now.</p>
                  <p className="text-xs mt-1">Intraday signals will appear here automatically when market scans trigger.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-8">
                  {/* Active Trades */}
                  {showActive && activeTrades.length > 0 && (
                    <div className="flex flex-col gap-3">
                      <h3 className="text-xs font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-bull animate-pulse" />
                        Active Trades ({activeTrades.length})
                      </h3>
                      <div className="grid">
                        {activeTrades.map((s) => (
                          <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Watchlist / Tomorrow Setups */}
                  {showWatchlist && rawWatchlistSetups.length > 0 && (
                    <div className="flex flex-col gap-3">
                      <h3 className="text-xs font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-2">
                        <Zap className="w-3.5 h-3.5 text-accent" />
                        Watchlist / Tomorrow Setups ({rawWatchlistSetups.length})
                      </h3>
                      <div className="grid">
                        {rawWatchlistSetups.map((s) => (
                          <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Completed Trades */}
                  {showCompleted && completedTrades.length > 0 && (
                    <div className="flex flex-col gap-3">
                      <h3 className="text-xs font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-foreground/60" />
                        Closed Intraday Trades ({completedTrades.length})
                      </h3>
                      <div className="grid">
                        {completedTrades.map((s) => (
                          <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Expired Trades */}
                  {showCompleted && expiredTrades.length > 0 && (
                    <div className="flex flex-col gap-3 pt-2">
                      <h3 className="text-xs font-bold tracking-widest uppercase text-muted-foreground/60 flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5" />
                        Expired / Unfilled Setups ({expiredTrades.length})
                      </h3>
                      <div className="grid">
                        {expiredTrades.map((s) => (
                          <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function SuggestionCard({ s, onSelectSymbol, onClose }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  s: any;
  onSelectSymbol?: (symbol: string) => void;
  onClose: () => void;
}) {
  const isWin = s.status.includes('TARGET');
  const isLoss = s.status === 'STOP_HIT';
  const isActive = s.status === 'ACTIVE';
  const pnlRaw = calcPnLPct(s.currentPrice, s.entryPrice);
  const pnlFromCurrent = isActive && pnlRaw != null
    ? s.direction === 'BUY' ? pnlRaw : -pnlRaw
    : null;

  return (
    <div
      onClick={() => {
        if (onSelectSymbol) {
          onSelectSymbol(s.symbol);
          onClose();
        }
      }}
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 py-4 border-b border-border/5 hover:border-border/30 active:scale-[0.995] transition-all duration-200 cursor-pointer group"
    >
      {/* Left Details */}
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="font-extrabold text-lg tracking-tight text-foreground group-hover:text-primary transition-colors">{s.symbol}</span>
          <span className={cn(
            "text-[10px] font-extrabold tracking-wider uppercase px-2 py-0.5 rounded-lg",
            s.direction === 'BUY' ? "text-bull bg-bull/15" : "text-bear bg-bear/15"
          )}>
            {s.direction}
          </span>
          {s.setupType && (
            <span className="text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-lg bg-secondary/60 text-muted-foreground">
              {s.setupType.replace(/_/g, ' ')}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs font-mono font-medium text-muted-foreground">
          {s.entryPrice != null && (
            <span>
              ENTRY <strong className="text-foreground">{fmtNum(s.entryPrice)}</strong>
            </span>
          )}
          {s.target1 != null && (
            <span>
              TGT <strong className="text-bull">{fmtNum(s.target1)}</strong>
              {s.target2 && <span className="text-muted-foreground"> / {fmtNum(s.target2)}</span>}
            </span>
          )}
          {s.stopLoss != null && (
            <span>
              SL <strong className="text-bear">{fmtNum(s.stopLoss)}</strong>
            </span>
          )}
          {s.riskReward != null && (
            <span>
              R:R <strong className="text-foreground">{s.riskReward.toFixed(1)}x</strong>
            </span>
          )}
          {s.status === 'WATCHLIST' && s.condition && (
            <span className="text-accent font-semibold truncate max-w-[220px]">
              {typeof s.condition === 'string' ? s.condition : s.condition.pattern_name || JSON.stringify(s.condition)}
            </span>
          )}
        </div>
      </div>

      {/* Right Stats & Badge */}
      <div className="flex items-center justify-between sm:justify-end gap-5 shrink-0 pt-2 sm:pt-0">
        {/* Active Trade Live Status */}
        {isActive && s.currentPrice != null && (
          <div className="flex flex-col items-end">
            <span className="text-xs font-mono font-bold text-muted-foreground">LTP: <strong className="text-foreground">{fmtNum(s.currentPrice)}</strong></span>
            {pnlFromCurrent != null && (
              <span className={cn("text-xs font-mono font-bold", pnlFromCurrent >= 0 ? "text-bull" : "text-bear")}>
                {pnlFromCurrent >= 0 ? '+' : ''}{pnlFromCurrent.toFixed(2)}%
              </span>
            )}
          </div>
        )}

        {/* Closed PnL */}
        {!isActive && s.pnlInr != null && (
          <span className={cn("text-base font-mono font-bold", s.pnlInr >= 0 ? "text-bull" : "text-bear")}>
            {s.pnlInr >= 0 ? '+' : ''}₹{Math.abs(s.pnlInr).toFixed(0)}
          </span>
        )}

        {/* Status Badge */}
        <div className="flex items-center gap-2 pr-2">
          <span className={cn(
            "w-1.5 h-1.5 rounded-full",
            isWin ? "bg-bull" :
            isLoss ? "bg-bear" :
            s.status === 'EXPIRED' ? "bg-muted-foreground/40" :
            s.status === 'WATCHLIST' ? "bg-accent" :
            "bg-bull animate-pulse"
          )} />
          <span className={cn(
            "text-[10px] font-bold tracking-wider uppercase",
            isWin ? "text-bull" :
            isLoss ? "text-bear" :
            s.status === 'EXPIRED' ? "text-muted-foreground" :
            s.status === 'WATCHLIST' ? "text-accent" :
            "text-bull"
          )}>
            {s.status.replace(/_/g, ' ')}
          </span>
        </div>
      </div>
    </div>
  );
}
