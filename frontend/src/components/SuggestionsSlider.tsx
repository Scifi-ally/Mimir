import { useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn, fmtNum, calcPnLPct } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSymbolDataSelector } from '@/providers/MarketDataProvider';

type FilterTab = 'ALL' | 'ACTIVE' | 'COMPLETED';

function formatDateGroup(dateStr: string | Date): string {
  const d = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatSuggestionText(s: import("@/types/api").Suggestion): string {
  return `${s.direction} ${s.symbol} @ ₹${fmtNum(s.entryPrice)} | TG: ₹${fmtNum(s.target1)} | SL: ₹${fmtNum(s.stopLoss)}`;
}

function CopyButton({ text, tooltip, className }: { text: string; tooltip?: string, className?: string }) {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  return (
    <button
      onClick={handleCopy}
      title={tooltip || "Copy"}
      className={cn("p-1.5 rounded-full bg-secondary/50 hover:bg-secondary text-muted-foreground hover:text-foreground transition-all pointer-events-auto active:scale-95", className)}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-bull" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export function SuggestionsSlider({ isOpen, onClose, onSelectSymbol }: { isOpen: boolean; onClose: () => void; onSelectSymbol?: (symbol: string) => void }) {
  const [activeTab, setActiveTab] = useState<FilterTab>('ALL');

  const { data: suggestionsData, isPending, error } = useQuery({
    queryKey: ['suggestions', 'history'],
    queryFn: () => api.historySuggestions(),
    refetchInterval: isOpen ? 5000 : false,
    staleTime: 0,
    enabled: isOpen,
  });

  const suggestions = suggestionsData?.data || [];

  const activeTrades = suggestions.filter(s => s.status === 'ACTIVE');
  const expiredTrades = suggestions.filter(s => s.status === 'EXPIRED');
  const completedTrades = suggestions.filter(s => s.status !== 'ACTIVE' && s.status !== 'EXPIRED');
  const winningTrades = completedTrades.filter(s => s.status.includes('TARGET'));

  const grossProfit = completedTrades.reduce((sum, s) => s.pnlInr && s.pnlInr > 0 ? sum + s.pnlInr : sum, 0);
  const grossLoss = Math.abs(completedTrades.reduce((sum, s) => s.pnlInr && s.pnlInr < 0 ? sum + s.pnlInr : sum, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 99.99 : 0) : grossProfit / grossLoss;
  const isProfitableSystem = profitFactor > 1 || (profitFactor === 0 && grossProfit > 0);

  const winRate = completedTrades.length > 0 ? (winningTrades.length / completedTrades.length) * 100 : 0;
  const totalPnl = completedTrades.reduce((sum, s) => sum + (s.pnlInr ?? 0), 0);

  const showActive = activeTab === 'ALL' || activeTab === 'ACTIVE';
  const showCompleted = activeTab === 'ALL' || activeTab === 'COMPLETED';

  // Group by date
  const grouped = suggestions.reduce((acc, s) => {
    const key = formatDateGroup(s.generatedAt);
    if (!acc[key]) acc[key] = { active: [], completed: [], expired: [] };
    
    if (s.status === 'ACTIVE') acc[key].active.push(s);
    else if (s.status === 'EXPIRED') acc[key].expired.push(s);
    else acc[key].completed.push(s);
    
    return acc;
  }, {} as Record<string, { active: import("@/types/api").Suggestion[], completed: import("@/types/api").Suggestion[], expired: import("@/types/api").Suggestion[] }>);

  const sortedDates = Object.keys(grouped).sort((a, b) => {
    const getDateVal = (key: string) => {
      if (key === 'Today') return new Date().getTime() + 100000;
      if (key === 'Yesterday') return new Date().getTime() - 86400000 + 100000;
      const parsed = new Date(key).getTime();
      return isNaN(parsed) ? 0 : parsed;
    };
    return getDateVal(b) - getDateVal(a);
  });

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
            className="fixed left-1/2 bottom-0 z-[70] flex flex-col bg-background/95 backdrop-blur-md border-t border-x border-border/30 text-foreground overflow-hidden h-[86vh] w-full max-w-4xl rounded-t-3xl shadow-[0_0_40px_rgba(0,0,0,0.5)]"
          >
            {/* Header */}
            <div className="relative px-8 pr-12 pt-6 pb-4 flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0 border-b border-border/10">
              <h2 className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-2">
                Performance & Signals
              </h2>

              {/* Clean Tabs */}
              <div className="flex items-center gap-5 mr-6">
                {(['ALL', 'ACTIVE', 'COMPLETED'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      "py-2 text-[10px] font-mono font-bold tracking-widest uppercase transition-all flex items-center gap-1.5 relative",
                      activeTab === tab
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground/80"
                    )}
                  >
                    {tab === 'ALL' ? 'ALL SETUPS' : tab === 'ACTIVE' ? `ACTIVE (${activeTrades.length})` : `CLOSED (${completedTrades.length + expiredTrades.length})`}
                    {activeTab === tab && (
                      <motion.div layoutId="activeSuggestionTabIndicator" className="absolute -bottom-0.5 left-0 right-0 h-[1px] bg-primary" />
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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 px-8 py-6 border-b border-border/5 shrink-0">
              <div className="flex flex-col gap-1.5">
                <div className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground">
                  Active Signals
                </div>
                <div className="text-3xl font-mono font-medium tabular-nums text-foreground">
                  {activeTrades.length}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground">
                  Win Rate
                </div>
                <div className="flex items-baseline gap-3">
                  <span className={cn("text-3xl font-mono font-medium tabular-nums", isProfitableSystem ? "text-bull" : completedTrades.length > 0 ? "text-bear" : "text-foreground")}>
                    {completedTrades.length > 0 ? `${winRate.toFixed(0)}%` : '—'}
                  </span>
                  {completedTrades.length > 0 && (
                    <span className="text-[11px] font-mono font-medium text-muted-foreground">
                      {winningTrades.length}W / {completedTrades.length - winningTrades.length}L
                    </span>
                  )}
                </div>
                {completedTrades.length > 0 && (
                  <div className="h-[2px] w-full bg-bear/20 overflow-hidden mt-1">
                    <div className="h-full bg-bull transition-all duration-500" style={{ width: `${winRate}%` }} />
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground">
                  Realized P&L
                </div>
                <div className={cn("text-3xl font-mono font-medium tabular-nums", totalPnl > 0 ? "text-bull" : totalPnl < 0 ? "text-bear" : "text-foreground")}>
                  {totalPnl > 0 ? '+' : totalPnl < 0 ? '-' : ''}₹{Math.abs(totalPnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground">
                  Profit Factor
                </div>
                <div className={cn("text-3xl font-mono font-medium tabular-nums", isProfitableSystem ? "text-bull" : completedTrades.length > 0 ? "text-bear" : "text-foreground")}>
                  {completedTrades.length > 0 ? (profitFactor >= 99.99 ? '99+' : profitFactor.toFixed(2)) : '—'}
                </div>
              </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-8 flex flex-col gap-10">
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
              ) : activeTrades.length === 0 && completedTrades.length === 0 && expiredTrades.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <p className="text-base font-semibold text-foreground mt-4">No signals active or generated right now.</p>
                  <p className="text-xs mt-1">Intraday signals will appear here automatically when market scans trigger.</p>
                </div>
              ) : (
                sortedDates.map((dateLabel) => {
                  const group = grouped[dateLabel];
                  const hasVisible = (showActive && group.active.length > 0) || (showCompleted && (group.completed.length > 0 || group.expired.length > 0));
                  if (!hasVisible) return null;

                  return (
                    <div key={dateLabel} className="flex flex-col gap-6 relative">
                      {/* Sticky Date Header */}
                      <div className="sticky top-0 z-10 py-2 pointer-events-none flex items-center gap-2">
                        <div className="inline-flex items-center px-3 py-1 rounded-full bg-background/95 border border-border/20 text-[10px] font-mono font-bold tracking-widest text-muted-foreground uppercase shadow-sm backdrop-blur-md pointer-events-auto">
                          {dateLabel}
                        </div>
                        <CopyButton 
                          tooltip={`Copy all for ${dateLabel}`} 
                          text={[
                            ...(showActive ? group.active : []),
                            ...(showCompleted ? group.completed : []),
                            ...(showCompleted ? group.expired : [])
                          ].map(formatSuggestionText).join('\n')}
                        />
                      </div>

                      <div className="flex flex-col gap-6 pl-2">
                        {/* Active Trades */}
                        {showActive && group.active.length > 0 && (
                          <div className="flex flex-col gap-3">
                            <h3 className="text-[10px] font-bold tracking-widest uppercase text-bull flex items-center gap-2">
                              Active Trades ({group.active.length})
                            </h3>
                            <div className="grid border-l-2 border-border/10 pl-4 ml-1">
                              {group.active.map((s: import("@/types/api").Suggestion) => (
                                <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Completed Trades */}
                        {showCompleted && group.completed.length > 0 && (
                          <div className="flex flex-col gap-3">
                            <h3 className="text-[10px] font-bold tracking-widest uppercase text-foreground/60 flex items-center gap-2">
                              Closed Trades ({group.completed.length})
                            </h3>
                            <div className="grid border-l-2 border-border/10 pl-4 ml-1">
                              {group.completed.map((s: import("@/types/api").Suggestion) => (
                                <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Expired Trades */}
                        {showCompleted && group.expired.length > 0 && (
                          <div className="flex flex-col gap-3 pt-1">
                            <h3 className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/40 flex items-center gap-2">
                              Expired / Unfilled Setups ({group.expired.length})
                            </h3>
                            <div className="grid border-l-2 border-border/10 pl-4 ml-1">
                              {group.expired.map((s: import("@/types/api").Suggestion) => (
                                <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function SuggestionCard({ s, onSelectSymbol, onClose }: {
  s: import("@/types/api").Suggestion;
  onSelectSymbol?: (symbol: string) => void;
  onClose: () => void;
}) {
  const isWin = s.status.includes('TARGET');
  const isLoss = s.status === 'STOP_HIT';
  const isActive = s.status === 'ACTIVE';
  
  const ltp = useSymbolDataSelector(isActive ? s.symbol : '', d => d.ltp);
  const currentPrice = isActive && ltp ? ltp : (s.currentPrice || s.outcomePrice);

  const pnlRaw = calcPnLPct(currentPrice, s.entryPrice);
  const pnlFromCurrent = isActive && pnlRaw != null
    ? s.direction === 'BUY' ? pnlRaw : -pnlRaw
    : null;

  let targetTimeStr = "N/A";
  if (isActive && currentPrice) {
    const distanceToTargetPct = (Math.abs(currentPrice - s.target1) / currentPrice) * 100;
    targetTimeStr = `${distanceToTargetPct.toFixed(2)}%`;
  }

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
      <div className="flex items-start sm:items-center gap-4">
        {/* Status indicator pill */}
        <div className={cn(
          "w-1 h-12 rounded-full hidden sm:block",
          isWin ? "bg-bull" : isLoss ? "bg-bear" : isActive ? "bg-primary" : "bg-muted-foreground/30"
        )} />
        
        <div className="flex flex-col">
          <div className="flex items-center gap-2 mb-1">
            <span className={cn(
              "text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider",
              s.direction === 'BUY' ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear"
            )}>
              {s.direction}
            </span>
            <span className="font-bold text-base tracking-tight">{s.symbol}</span>
            <span className="text-[10px] text-muted-foreground/60 font-mono hidden sm:inline-block">#{s.id.slice(-4)}</span>
          </div>
          
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="text-foreground/40 text-[10px] uppercase tracking-wider">EN</span>
              <span className="font-mono font-medium text-foreground/80">₹{fmtNum(s.entryPrice)}</span>
            </span>
            <span className="text-border/40">•</span>
            <span className="flex items-center gap-1">
              <span className="text-foreground/40 text-[10px] uppercase tracking-wider">TG</span>
              <span className="font-mono font-medium text-foreground/80">₹{fmtNum(s.target1)}</span>
            </span>
            <span className="text-border/40">•</span>
            <span className="flex items-center gap-1">
              <span className="text-foreground/40 text-[10px] uppercase tracking-wider">SL</span>
              <span className="font-mono font-medium text-foreground/80">₹{fmtNum(s.stopLoss)}</span>
            </span>
            <span className="text-border/40">•</span>
            <span className="flex items-center gap-1">
              <span className="text-foreground/40 text-[10px] uppercase tracking-wider">GEN</span>
              <span className="font-mono font-medium text-foreground/80">{new Date(s.generatedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
            </span>
            {isActive && (
              <>
                <span className="text-border/40">•</span>
                <span className="flex items-center gap-1">
                  <span className="text-foreground/40 text-[10px] uppercase tracking-wider">DIST</span>
                  <span className="font-mono font-medium text-foreground/80">{targetTimeStr}</span>
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between sm:justify-end gap-6 sm:w-1/3">
        {/* Current Price / Outcome */}
        <div className="flex flex-col items-start sm:items-end">
          <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground mb-1">
            {isActive ? "Current" : "Outcome"}
          </span>
          <span className="font-mono font-bold text-sm">
            ₹{fmtNum(isActive ? currentPrice : s.outcomePrice || currentPrice)}
          </span>
        </div>

        {/* P&L */}
        <div className="flex flex-col items-end min-w-[70px]">
          <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground mb-1">
            P&L
          </span>
          {isWin ? (
            <span className="font-mono font-bold text-sm text-bull flex items-center gap-0.5">
              +₹{fmtNum(s.pnlInr)}
            </span>
          ) : isLoss ? (
            <span className="font-mono font-bold text-sm text-bear flex items-center gap-0.5">
              -₹{fmtNum(Math.abs(s.pnlInr ?? 0))}
            </span>
          ) : isActive && pnlFromCurrent != null ? (
            <span className={cn("font-mono font-bold text-sm", pnlFromCurrent > 0 ? "text-bull" : pnlFromCurrent < 0 ? "text-bear" : "text-foreground")}>
              {pnlFromCurrent > 0 ? "+" : ""}{pnlFromCurrent.toFixed(2)}%
            </span>
          ) : (
            <span className="font-mono font-bold text-sm text-muted-foreground/50">—</span>
          )}
        </div>

        {/* Copy Button */}
        <div className="flex items-center border-l border-border/10 pl-4 ml-2">
          <CopyButton text={formatSuggestionText(s)} tooltip="Copy signal" />
        </div>
      </div>
    </div>
  );
}
