import { useEffect, useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn, fmtNum, calcPnLPct, toFixed } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSymbolDataSelector } from '@/providers/MarketDataProvider';
import { LivePrice } from '@/components/atoms/LivePrice';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import { FADE_STANDARD, SPRING_GENTLE } from "@/lib/motion";



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
    refetchInterval: isOpen ? 30000 : false, // closed history changes rarely
    staleTime: 0,
    enabled: isOpen,
  });

  const { data: accuracy } = useQuery({
    queryKey: ['suggestions', 'accuracy'],
    queryFn: () => api.suggestionsAccuracy(),
    staleTime: 5 * 60_000,
    enabled: isOpen,
  });



  const historySuggestions = suggestionsData?.data || [];
  const activeTrades = (activeSuggestions || []).filter(s => s.status === 'ACTIVE' || s.status === 'PENDING');
  const expiredTrades = historySuggestions.filter((s: import("@/types/api").Suggestion) => s.status === 'EXPIRED' || s.status === 'MISSED');
  // Allow-list of terminal traded outcomes — REJECTED (dismissed, never traded) must not appear in any bucket
  const completedTrades = historySuggestions.filter((s: import("@/types/api").Suggestion) => s.status === 'TARGET_1_HIT' || s.status === 'TARGET_2_HIT' || s.status === 'STOP_HIT' || s.status === 'CLOSED');

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={FADE_STANDARD}
            className="fixed inset-0 z-[60] bg-background/70 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Modal Panel */}
          <motion.div
            initial={{ y: "100%", x: "-50%" }}
            animate={{ y: 0, x: "-50%" }}
            exit={{ y: "100%", x: "-50%" }}
            transition={SPRING_GENTLE}
            className="fixed left-1/2 bottom-0 z-[70] flex flex-col bg-background text-foreground overflow-hidden h-[86vh] w-full max-w-4xl rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.4)] ring-0 outline-none"
          >
            {/* Header */}
            <div className="relative px-8 pr-12 pt-6 pb-4 flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0">
              <h2 className="text-[9px] font-mono font-normal tracking-[0.15em] uppercase text-muted-foreground/80">
                Active Signals
              </h2>

              <button
                onClick={onClose}
                className="absolute right-6 top-6 z-10 p-2 rounded-full hover:bg-foreground/[0.06] text-muted-foreground/60 hover:text-foreground transition-colors duration-150"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            {/* Realized track record — measured outcomes, not projections */}
            {accuracy && accuracy.closedTrades >= 10 && accuracy.winRate != null && (
              <div className="px-8 pb-3 shrink-0 flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px] font-mono text-muted-foreground">
                <span>
                  <span className={cn("font-normal", accuracy.winRate >= 55 ? "text-bull" : accuracy.winRate >= 45 ? "text-amber-500" : "text-bear")}>{accuracy.winRate}%</span>
                  {" "}win rate
                </span>
                <span>
                  <span className={cn("font-normal", accuracy.totalPnlInr >= 0 ? "text-bull" : "text-bear")}>
                    {accuracy.totalPnlInr >= 0 ? "+" : "-"}₹{fmtNum(Math.abs(accuracy.totalPnlInr))}
                  </span>
                  {" "}net P&L
                </span>
                <span>{accuracy.closedTrades} closed trades · last {accuracy.lookbackDays} days</span>
              </div>
            )}

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
                <div className="flex-1 flex items-center justify-center py-20 text-destructive text-sm font-normal">
                  {error instanceof Error ? error.message : "Failed to load signals"}
                </div>
              ) : activeTrades.length === 0 && completedTrades.length === 0 && expiredTrades.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
                  <p className="text-sm font-normal text-foreground">No signals generated yet</p>
                </div>
              ) : (
                <>
                  {activeTrades.length === 0 && (
                    <div className="flex flex-col items-center justify-center p-8 text-center">
                      <p className="text-sm font-normal text-foreground">No active signals — scanner monitoring</p>
                    </div>
                  )}
                  {activeTrades.length > 0 && (
                    <div className="flex flex-col gap-6 relative">
                      <div className="flex flex-col gap-6 pl-2">
                        <div className="flex flex-col gap-3">
                          <h3 className="text-[10px] font-normal tracking-widest uppercase text-bull flex items-center gap-2">
                            Active Trades ({activeTrades.length})
                          </h3>
                          <div className="grid pl-4 ml-1">
                            {activeTrades.map((s: import("@/types/api").Suggestion) => (
                              <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  {completedTrades.length > 0 && (
                    <div className="flex flex-col gap-3 pl-2">
                      <h3 className="text-[10px] font-normal tracking-widest uppercase text-muted-foreground flex items-center gap-2">
                        Completed ({completedTrades.length})
                      </h3>
                      <div className="grid pl-4 ml-1">
                        {completedTrades.map((s: import("@/types/api").Suggestion) => (
                          <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                        ))}
                      </div>
                    </div>
                  )}
                  {expiredTrades.length > 0 && (
                    <div className="flex flex-col gap-3 pl-2">
                      <h3 className="text-[10px] font-normal tracking-widest uppercase text-muted-foreground/60 flex items-center gap-2">
                        Expired ({expiredTrades.length})
                      </h3>
                      <div className="grid pl-4 ml-1">
                        {expiredTrades.map((s: import("@/types/api").Suggestion) => (
                          <SuggestionCard key={s.id} s={s} onSelectSymbol={onSelectSymbol} onClose={onClose} />
                        ))}
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
  const isPending = s.status === 'PENDING'; // signal generated, entry not yet touched
  const isActive = s.status === 'ACTIVE' || isPending;
  
  const ltp = useSymbolDataSelector(isActive ? s.symbol : '', d => d.ltp);
  const currentPrice = isActive && ltp ? ltp : (s.currentPrice || s.outcomePrice);

  const pnlRaw = calcPnLPct(currentPrice, s.entryPrice);
  // PENDING = entry never touched — no position exists, so never show a live P&L for it
  const pnlFromCurrent = !isPending && isActive && pnlRaw != null
    ? s.direction === 'BUY' ? pnlRaw : -pnlRaw
    : null;

  let targetTimeStr = "N/A";
  if (isActive && currentPrice) {
    // For unfilled signals the relevant distance is to ENTRY, not target
    const refPrice = isPending ? s.entryPrice : s.target1;
    const distancePct = (Math.abs(currentPrice - refPrice) / currentPrice) * 100;
    targetTimeStr = `${toFixed(distancePct, 2)}%`;
  }

  const fmtMinutes = (m: number) =>
    m >= 390 ? `~${Math.round(m / 390)}d` : m >= 60 ? `~${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim() : `~${m}m`;

  const expectedHold = s.expectedHoldMinutes != null ? fmtMinutes(s.expectedHoldMinutes) : null;

  // Realized attainability for this setup type (from closed-trade calibration)
  const stats = s.setupStats;
  const medianToTarget = stats?.medianTimeToTargetMin != null ? fmtMinutes(stats.medianTimeToTargetMin) : null;

  // Time remaining before the signal's time-stop; render must stay pure, so the
  // clock lives in state and ticks via an interval instead of calling Date.now() inline
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive || !s.expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [isActive, s.expiresAt]);
  let expiresIn: string | null = null;
  if (isActive && s.expiresAt) {
    const msLeft = new Date(s.expiresAt).getTime() - now;
    if (msLeft > 0) {
      const mins = Math.round(msLeft / 60_000);
      expiresIn = mins >= 24 * 60 ? `${Math.round(mins / (24 * 60))}d` : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    } else {
      expiresIn = "expiring";
    }
  }

  return (
    <div
      onClick={() => {
        if (onSelectSymbol) {
          onSelectSymbol(s.symbol);
          onClose();
        }
      }}
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 py-4 active:scale-[0.998] transition-all duration-150 ease-out cursor-pointer group hover:bg-foreground/[0.02] rounded-xl px-3 -mx-3"
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
              "text-[10px] font-normal px-1.5 py-0.5 rounded uppercase tracking-wider",
              s.direction === 'BUY' ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear"
            )}>
              {s.direction}
            </span>
            <span className="font-normal text-base tracking-tight">{s.symbol}</span>
            <span className="text-[10px] text-muted-foreground/60 font-mono hidden sm:inline-block">#{s.id.slice(-4)}</span>
          </div>
          
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="text-foreground/40 text-[10px] uppercase tracking-wider">EN</span>
              <span className="font-mono font-normal text-foreground/80">₹{fmtNum(s.entryPrice)}</span>
            </span>
            <span className="text-border/40">•</span>
            <span className="flex items-center gap-1">
              <span className="text-foreground/40 text-[10px] uppercase tracking-wider">TG</span>
              <span className="font-mono font-normal text-foreground/80">₹{fmtNum(s.target1)}</span>
            </span>
            <span className="text-border/40">•</span>
            <span className="flex items-center gap-1">
              <span className="text-foreground/40 text-[10px] uppercase tracking-wider">SL</span>
              <span className="font-mono font-normal text-foreground/80">₹{fmtNum(s.stopLoss)}</span>
            </span>
            <span className="text-border/40">•</span>
            <span className="flex items-center gap-1">
              <span className="text-foreground/40 text-[10px] uppercase tracking-wider">GEN</span>
              <span className="font-mono font-normal text-foreground/80">{new Date(s.generatedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
            </span>
            {expectedHold && (
              <>
                <span className="text-border/40">â€¢</span>
                <span className="flex items-center gap-1">
                  <span className="text-foreground/40 text-[10px] uppercase tracking-wider">HOLD</span>
                  <span className="font-mono font-normal text-foreground/80">{expectedHold}</span>
                </span>
              </>
            )}
            {isActive && (
              <>
                <span className="text-border/40">•</span>
                <span className="flex items-center gap-1" title={isPending ? "Distance from current price to entry" : "Distance from current price to target"}>
                  <span className="text-foreground/40 text-[10px] uppercase tracking-wider">{isPending ? "TO EN" : "DIST"}</span>
                  <span className="font-mono font-normal text-foreground/80">{targetTimeStr}</span>
                </span>
              </>
            )}
            {expiresIn && (
              <>
                <span className="text-border/40">•</span>
                <span className="flex items-center gap-1" title="Time remaining before this signal's time-stop">
                  <span className="text-foreground/40 text-[10px] uppercase tracking-wider">EXP</span>
                  <span className={cn("font-mono font-normal", expiresIn === "expiring" ? "text-amber-500" : "text-foreground/80")}>{expiresIn}</span>
                </span>
              </>
            )}
          </div>
          {stats && (
            <div className="flex items-center gap-2 mt-1.5" title={`Realized outcomes for ${s.setupType} over last 120 days (${stats.samples} closed trades)`}>
              <span className={cn(
                "text-[10px] font-normal px-1.5 py-0.5 rounded font-mono",
                stats.winRate >= 60 ? "bg-bull/10 text-bull" : stats.winRate >= 45 ? "bg-amber-500/10 text-amber-500" : "bg-bear/10 text-bear"
              )}>
                {stats.winRate}% hit rate
              </span>
              {medianToTarget && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  target typically reached in {medianToTarget}
                </span>
              )}
              <span className="text-[10px] font-mono text-muted-foreground/50">n={stats.samples}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between sm:justify-end gap-6 sm:w-1/3">
        {/* Current Price / Outcome */}
        <div className="flex flex-col items-start sm:items-end">
          <span className="text-[10px] font-normal tracking-widest uppercase text-muted-foreground mb-1">
            {isPending ? "Awaiting Entry" : isActive ? "Current" : "Outcome"}
          </span>
          <span className="font-mono font-normal text-sm">
            {isActive ? (
              <LivePrice symbol={s.symbol} decimals={2} fallback={currentPrice} />
            ) : (
              `₹${fmtNum(s.outcomePrice || currentPrice)}`
            )}
          </span>
        </div>

        {/* P&L */}
        <div className="flex flex-col items-end min-w-[70px]">
          <span className="text-[10px] font-normal tracking-widest uppercase text-muted-foreground mb-1">
            P&L
          </span>
          {isWin ? (
            <span className="font-mono font-normal text-sm text-bull flex items-center gap-0.5">
              +₹{fmtNum(s.pnlInr)}
            </span>
          ) : isLoss ? (
            <span className="font-mono font-normal text-sm text-bear flex items-center gap-0.5">
              -₹{fmtNum(Math.abs(s.pnlInr ?? 0))}
            </span>
          ) : isActive && pnlFromCurrent != null ? (
            <span className={cn("font-mono font-normal text-sm", pnlFromCurrent > 0 ? "text-bull" : pnlFromCurrent < 0 ? "text-bear" : "text-foreground")}>
              <AnimatedNumber value={pnlFromCurrent} decimals={2} showSign={true} suffix="%" duration={0.3} flashColor={true} />
            </span>
          ) : (
            <span className="font-mono font-normal text-sm text-muted-foreground/50">—</span>
          )}
        </div>

        {/* Copy Button */}
        <div className="flex items-center pl-4 ml-2">
          <CopyButton text={formatSuggestionText(s)} tooltip="Copy signal" />
        </div>
      </div>
    </div>
  );
}
