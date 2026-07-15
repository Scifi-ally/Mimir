import { useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn, fmtNum, calcPnLPct, toFixed } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSymbolDataSelector } from '@/providers/MarketDataProvider';
import { LivePrice } from '@/components/atoms/LivePrice';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';



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

export function SuggestionsSlider({ isOpen, onClose, onSelectSymbol, activeSuggestions }: { isOpen: boolean; onClose: () => void; onSelectSymbol?: (symbol: string) => void; activeSuggestions?: import("@/types/api").Suggestion[] }) {

  const { data: suggestionsData, isPending, error } = useQuery({
    queryKey: ['suggestions', 'history'],
    queryFn: () => api.historySuggestions(),
    refetchInterval: isOpen ? 5000 : false,
    staleTime: 0,
    enabled: isOpen,
  });



  const historySuggestions = suggestionsData?.data || [];
  const activeTrades = (activeSuggestions || []).filter(s => s.status === 'ACTIVE');
  const expiredTrades = historySuggestions.filter((s: import("@/types/api").Suggestion) => s.status === 'EXPIRED');
  const completedTrades = historySuggestions.filter((s: import("@/types/api").Suggestion) => s.status !== 'ACTIVE' && s.status !== 'EXPIRED');

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[60] bg-background/80"
            onClick={onClose}
          />

          {/* Modal Panel */}
          <motion.div 
            initial={{ y: "100%", x: "-50%" }}
            animate={{ y: 0, x: "-50%" }}
            exit={{ y: "100%", x: "-50%" }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="fixed left-1/2 bottom-0 z-[70] flex flex-col bg-background text-foreground overflow-hidden h-[86vh] w-full max-w-4xl rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.08)] dark:shadow-[0_-8px_40px_rgba(0,0,0,0.4)] border border-b-0 border-foreground/5 ring-0 outline-none"
          >
            {/* Header */}
            <div className="relative px-8 pr-12 pt-6 pb-4 flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0 border-b border-border/10">
              <h2 className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-2">
                Active Signals Generated
              </h2>

              {/* Tabs removed as requested */}

              <button 
                onClick={onClose}
                className="absolute right-6 top-6 z-10 p-2 rounded-full hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-all duration-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Essential Stats Row removed as requested */}

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
                <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground gap-3">
                  <p className="text-base font-semibold text-foreground mt-4">No signals active or generated right now.</p>
                  <p className="text-xs mt-1">Intraday signals will appear here automatically when market scans trigger.</p>
                </div>
              ) : (
                <>
                  {activeTrades.length === 0 && (
                    <div className="flex flex-col items-center justify-center p-8 text-center gap-2">
                      <p className="text-sm font-semibold text-foreground">0 Active BUY/SELL Signals Right Now</p>
                      <p className="text-xs text-muted-foreground max-w-md">Our intraday AI scanner is actively monitoring the market for new setups. Signals will appear here when triggered.</p>
                    </div>
                  )}
                  {activeTrades.length > 0 && (
                    <div className="flex flex-col gap-6 relative">
                      <div className="flex flex-col gap-6 pl-2">
                        <div className="flex flex-col gap-3">
                          <h3 className="text-[10px] font-bold tracking-widest uppercase text-bull flex items-center gap-2">
                            Active Trades ({activeTrades.length})
                          </h3>
                          <div className="grid border-l-2 border-border/10 pl-4 ml-1">
                            {activeTrades.map((s: import("@/types/api").Suggestion) => (
                              <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
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
    targetTimeStr = `${toFixed(distanceToTargetPct, 2)}%`;
  }

  const expectedHold = s.expectedHoldMinutes != null
    ? s.expectedHoldMinutes >= 60
      ? `~${Math.floor(s.expectedHoldMinutes / 60)}h ${s.expectedHoldMinutes % 60}m`
      : `~${s.expectedHoldMinutes}m`
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
            {expectedHold && (
              <>
                <span className="text-border/40">â€¢</span>
                <span className="flex items-center gap-1">
                  <span className="text-foreground/40 text-[10px] uppercase tracking-wider">HOLD</span>
                  <span className="font-mono font-medium text-foreground/80">{expectedHold}</span>
                </span>
              </>
            )}
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
            {isActive ? (
              <LivePrice symbol={s.symbol} decimals={2} fallback={currentPrice} />
            ) : (
              `₹${fmtNum(s.outcomePrice || currentPrice)}`
            )}
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
              <AnimatedNumber value={pnlFromCurrent} decimals={2} showSign={true} suffix="%" duration={0.3} flashColor={true} />
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
