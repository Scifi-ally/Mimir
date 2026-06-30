import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Bell, Trash2, Plus, Play, Pause, Pencil, SlidersHorizontal } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@/store/useStore";
import { AdvancedRuleBuilder } from "./AdvancedRuleBuilder";


interface CustomScreenerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenAlerts: () => void;
}

type Operator = ">" | "<" | ">=" | "<=" | "==" | "!=" | "CROSSES_ABOVE" | "CROSSES_BELOW";
type ScheduleMode = "MARKET_OPEN" | "MARKET_CLOSE" | "EVERY_MINUTE" | "TIME" | "ON_DEMAND" | "EVERY_CANDLE";
type RuleNode = {
  type: "CONDITION" | "AND" | "OR";
  indicatorA?: string;
  operator?: Operator;
  indicatorB?: string;
  alertMessage?: string;
  rules?: RuleNode[];
};

type ScreenerRule = {
  id: number;
  symbol?: string | null;
  targetType?: string | null;
  outputName?: string | null;
  timeframe: string;
  indicatorA?: string | null;
  operator?: Operator | null;
  indicatorB?: string | null;
  conditions?: RuleNode | null;
  scheduleMode?: ScheduleMode | null;
  scheduleTime?: string | null;
  status?: string | null;
  lastTriggeredAt?: string | null;
};

type ScreenerTarget = {
  id: number;
  screenerId: number | null;
  symbol: string;
  notes?: string | null;
};

type ScreenerMatch = {
  id: number;
  screenerId: number;
  symbol: string;
  condition: string;
  matchedAt: string;
};

function countTreeConditions(node?: RuleNode | null): number {
  if (!node) return 0;
  if (node.type === "CONDITION") return 1;
  return (node.rules || []).reduce((sum, child) => sum + countTreeConditions(child), 0);
}

export function CustomScreenerModal({ isOpen, onClose, onOpenAlerts }: CustomScreenerModalProps) {
  const queryClient = useQueryClient();
  const showIsland = useStore((s) => s.showIsland);

  const [symbol, setSymbol] = useState("ALL");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [editingRule, setEditingRule] = useState<any | null>(null);
  const [indicatorA, setIndicatorA] = useState("PRICE");
  const [operator, setOperator] = useState<">"|"<"|">="|"<="|"=="|"!="|"CROSSES_ABOVE"|"CROSSES_BELOW">("CROSSES_ABOVE");
  const [indicatorB, setIndicatorB] = useState("EMA20");
  const [timeframe, setTimeframe] = useState<"1m"|"5m"|"15m"|"1h"|"1d">("15m");
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("MARKET_OPEN");
  const [scheduleTime, setScheduleTime] = useState("09:15");

  const { data: rules = [] } = useQuery<ScreenerRule[]>({
    queryKey: ["screener_rules"],
    queryFn: async () => {
      const res = await fetch("/api/screener");
      if (!res.ok) throw new Error("Failed to fetch rules");
      return res.json();
    },
    enabled: isOpen
  });

  const { data: targets = [] } = useQuery<ScreenerTarget[]>({
    queryKey: ["screener_targets"],
    queryFn: async () => {
      const res = await fetch("/api/screener/targets");
      if (!res.ok) throw new Error("Failed to fetch targets");
      return res.json();
    },
    enabled: isOpen,
  });

  const { data: matches = [] } = useQuery<ScreenerMatch[]>({
    queryKey: ["screener_matches"],
    queryFn: async () => {
      const res = await fetch("/api/screener/matches");
      if (!res.ok) throw new Error("Failed to fetch matches");
      return res.json();
    },
    enabled: isOpen,
  });

  const createRuleMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/screener", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          timeframe,
          indicatorA,
          operator,
          indicatorB,
          scheduleMode,
          scheduleTime: scheduleMode === "TIME" ? scheduleTime : undefined,
        })
      });
      if (!res.ok) throw new Error("Failed to create rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["screener_rules"] });
    }
  });

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/screener/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["screener_rules"] });
    }
  });

  const toggleRuleMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/screener/${id}/toggle`, { method: "PATCH" });
      if (!res.ok) throw new Error("Failed to toggle rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["screener_rules"] });
    }
  });

  const runScreenerMutation = useMutation({
    mutationFn: async (screenerId?: number) => {
      const res = await fetch("/api/screener/run", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(screenerId ? { screenerId } : {})
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || body?.message || "Failed to run screener");
      return body as { activeScreeners: number; newMatches: number; newTargets: number };
    },
    onSuccess: async (summary) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["screener_rules"] }),
        queryClient.invalidateQueries({ queryKey: ["screener_targets"] }),
        queryClient.invalidateQueries({ queryKey: ["screener_matches"] }),
      ]);
      showIsland({
        title: "Screener run complete",
        subtitle: `Scanned ${summary.activeScreeners} active rule${summary.activeScreeners === 1 ? "" : "s"}. ${summary.newMatches} new match${summary.newMatches === 1 ? "" : "es"}, ${summary.newTargets} stock${summary.newTargets === 1 ? "" : "s"} added.`,
        showSuccessOnly: true,
        hideCancel: true,
      });
    },
  });

  const activeRules = rules.filter((rule) => rule.status !== "PAUSED").length;
  const customWatchlists = rules.filter((rule) => rule.targetType === "CUSTOM").length;

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6 lg:p-8">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="absolute inset-0 bg-background/80 backdrop-blur-xl"
          onClick={onClose}
        />
        
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 15 }}
          transition={{ type: "spring", stiffness: 350, damping: 30 }}
          className="relative w-full max-w-3xl flex flex-col pointer-events-none"
        >
          {/* Header Controls (Floating) */}
          <div className="flex items-center justify-between mb-12 pointer-events-auto">
            <h2 className="text-2xl font-bold tracking-tight text-foreground/90 font-mono">
              SCREENER // RULES
            </h2>
            <div className="flex items-center gap-6">
              <button
                onClick={onOpenAlerts}
                className="group flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors uppercase tracking-widest"
              >
                <Bell className="h-4 w-4" />
                Alerts
              </button>

              <button 
                onClick={onClose} 
                className="group flex items-center justify-center text-muted-foreground hover:text-foreground transition-all"
              >
                <X className="h-6 w-6 group-hover:rotate-90 transition-transform duration-300" />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-16 pointer-events-auto">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Rules", rules.length],
                ["Active", activeRules],
                ["Watchlists", customWatchlists],
                ["Matches", matches.length],
              ].map(([label, value]) => (
                <motion.div
                  key={label}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-xl bg-secondary/10 px-4 py-3"
                >
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
                  <div className="mt-1 text-xl font-bold text-foreground">{value}</div>
                </motion.div>
              ))}
            </div>
            
            {/* Ultra-Minimalist Typography Builder or Advanced Rule Builder */}
            {editingRule ? (
              <div className="flex flex-col gap-6 w-full bg-secondary/10 p-6 rounded-2xl border border-border/40">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold tracking-tight text-foreground">
                    {editingRule.id ? `Edit Screener Rule #${editingRule.id}` : "Advanced Screener Rule Builder"}
                  </h3>
                  <button
                    onClick={() => setEditingRule(null)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/60 text-xs font-semibold hover:bg-secondary transition-colors"
                  >
                    <X className="h-3.5 w-3.5" /> Back to simple builder
                  </button>
                </div>
                <AdvancedRuleBuilder
                  initialRule={editingRule.id ? editingRule : undefined}
                  onComplete={() => {
                    setEditingRule(null);
                  }}
                />
              </div>
            ) : (
              <div className="flex flex-col items-start gap-8 w-full">
                <div className="flex items-center justify-between w-full">
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Add New Condition</p>
                  <button
                    onClick={() => setEditingRule({})}
                    className="text-xs font-semibold text-primary hover:underline flex items-center gap-1.5"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" /> Advanced Multi-Condition Builder
                  </button>
                </div>
              
                <div className="w-full flex flex-wrap items-baseline gap-4 sm:gap-6 text-3xl sm:text-4xl font-light tracking-tight text-foreground">
                  <input
                    id="screener-symbol"
                    name="screener-symbol"
                    aria-label="Symbol"
                    type="text"
                    value={symbol}
                    onChange={e => setSymbol(e.target.value.toUpperCase())}
                    placeholder="ALL"
                    className="bg-transparent outline-none placeholder:text-muted-foreground/20 transition-colors focus:text-primary w-fit"
                    style={{ width: `${Math.max(symbol.length, 3)}ch` }}
                  />
                  
                  <span className="text-muted-foreground/20 font-thin">/</span>
                  
                  <input
                    id="screener-indicator-a"
                    name="screener-indicator-a"
                    aria-label="First Indicator"
                    type="text"
                    value={indicatorA}
                    onChange={e => setIndicatorA(e.target.value.toUpperCase())}
                    placeholder="PRICE"
                    className="bg-transparent outline-none placeholder:text-muted-foreground/20 transition-colors focus:text-primary w-fit"
                    style={{ width: `${Math.max(indicatorA.length, 5)}ch` }}
                  />
                  
                  <span className="text-muted-foreground/20 font-thin">/</span>
                  
                  <select
                    id="screener-operator"
                    name="screener-operator"
                    aria-label="Operator"
                    value={operator}
                    onChange={e => setOperator(e.target.value as Operator)}
                    className="appearance-none bg-transparent outline-none transition-colors text-muted-foreground hover:text-foreground focus:text-primary cursor-pointer w-auto pr-2"
                  >
                    <option className="bg-background text-foreground text-lg font-sans" value=">">Greater than</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="<">Less than</option>
                    <option className="bg-background text-foreground text-lg font-sans" value=">=">At least</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="<=">At most</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="==">Equals</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="!=">Not equal</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="CROSSES_ABOVE">Crosses above</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="CROSSES_BELOW">Crosses below</option>
                  </select>
                  
                  <span className="text-muted-foreground/20 font-thin">/</span>
                  
                  <input
                    id="screener-indicator-b"
                    name="screener-indicator-b"
                    aria-label="Second Indicator"
                    type="text"
                    value={indicatorB}
                    onChange={e => setIndicatorB(e.target.value.toUpperCase())}
                    placeholder="EMA20"
                    className="bg-transparent outline-none placeholder:text-muted-foreground/20 transition-colors focus:text-primary w-fit"
                    style={{ width: `${Math.max(indicatorB.length, 5)}ch` }}
                  />
                  
                  <span className="text-muted-foreground/20 font-thin">/</span>
                  
                  <select
                    id="screener-timeframe"
                    name="screener-timeframe"
                    aria-label="Timeframe"
                    value={timeframe}
                    onChange={e => setTimeframe(e.target.value as "1m"|"5m"|"15m"|"1h"|"1d")}
                    className="appearance-none bg-transparent outline-none transition-colors text-muted-foreground hover:text-foreground focus:text-primary cursor-pointer w-auto pr-2"
                  >
                    <option className="bg-background text-foreground text-lg font-sans" value="1m">1 Min</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="5m">5 Min</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="15m">15 Min</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="1h">1 Hour</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="1d">1 Day</option>
                  </select>

                  <span className="text-muted-foreground/20 font-thin">/</span>

                  <select
                    id="screener-schedule-mode"
                    name="screener-schedule-mode"
                    aria-label="Schedule Mode"
                    value={scheduleMode}
                    onChange={e => setScheduleMode(e.target.value as ScheduleMode)}
                    className="appearance-none bg-transparent outline-none transition-colors text-muted-foreground hover:text-foreground focus:text-primary cursor-pointer w-auto pr-2"
                  >
                    <option className="bg-background text-foreground text-lg font-sans" value="MARKET_OPEN">Market Open</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="MARKET_CLOSE">Market Close</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="EVERY_MINUTE">Every Minute</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="EVERY_CANDLE">Every Candle Close</option>
                    <option className="bg-background text-foreground text-lg font-sans" value="TIME">Specific Time</option>
                  </select>

                  {scheduleMode === "TIME" && (
                    <input
                      id="screener-schedule-time"
                      name="screener-schedule-time"
                      aria-label="Schedule Time"
                      type="time"
                      value={scheduleTime}
                      onChange={(event) => setScheduleTime(event.target.value)}
                      className="bg-transparent outline-none placeholder:text-muted-foreground/20 transition-colors focus:text-primary w-[5ch]"
                    />
                  )}
                  
                  <button
                    onClick={() => createRuleMutation.mutate()}
                    disabled={createRuleMutation.isPending || !indicatorA || !indicatorB}
                    className="ml-auto sm:ml-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all hover:scale-110 disabled:opacity-30 disabled:hover:scale-100 mt-4 sm:mt-0"
                  >
                    <Plus className="h-6 w-6" />
                  </button>
                </div>
              </div>
            )}

            {/* Active Rules List */}
            <div className="flex flex-col gap-6">
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Active Conditions</p>
              
              <div className="flex flex-col gap-4">
                {!rules?.length && (
                  <div className="flex items-center gap-4 text-muted-foreground/50">
                    <span className="h-px flex-1 bg-gradient-to-r from-muted-foreground/10 to-transparent" />
                    <span className="font-mono text-sm">No rules active.</span>
                    <span className="h-px flex-1 bg-gradient-to-l from-muted-foreground/10 to-transparent" />
                  </div>
                )}
                
                {rules.map((rule) => {
                  const isAdvanced = !!rule.conditions;
                  const conditionSummary = isAdvanced 
                    ? `${countTreeConditions(rule.conditions)} conditions (${rule.conditions?.type || 'AND'})`
                    : `${rule.indicatorA} ${rule.operator === ">" ? ">" : rule.operator === "<" ? "<" : rule.operator === "CROSSES_ABOVE" ? "crosses above" : rule.operator === "CROSSES_BELOW" ? "crosses below" : rule.operator === ">=" ? "≥" : rule.operator === "<=" ? "≤" : rule.operator === "==" ? "=" : "≠"} ${rule.indicatorB}`;
                  const isPaused = rule.status === "PAUSED";
                  const ruleTargets = targets.filter((target) => target.screenerId === rule.id);
                  const ruleMatches = matches.filter((match) => match.screenerId === rule.id);
                  return (
                    <motion.div
                      key={rule.id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="group flex items-center justify-between py-2 transition-all"
                    >
                      <div className="flex items-baseline gap-3 text-lg font-light text-foreground/80 flex-wrap">
                        <span className={`font-bold mr-2 ${isPaused ? 'text-muted-foreground' : 'text-primary'}`}>
                          {rule.outputName || rule.symbol || 'ALL'}
                        </span>
                        <span className={isPaused ? 'opacity-50' : ''}>{conditionSummary}</span>
                        <span className="text-muted-foreground text-sm ml-2 font-mono bg-foreground/5 px-2 py-0.5 rounded">
                          {rule.timeframe}
                        </span>
                        {rule.targetType && rule.targetType !== 'ALL' && (
                          <span className="text-xs font-mono px-2 py-0.5 rounded bg-primary/10 text-primary">
                            {rule.targetType}
                          </span>
                        )}
                        {isPaused && (
                          <span className="text-xs font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-500">PAUSED</span>
                        )}
                        <span className="text-xs font-mono px-2 py-0.5 rounded bg-foreground/5 text-muted-foreground">
                          {rule.scheduleMode === "EVERY_MINUTE" ? "EVERY MIN" : rule.scheduleMode === "MARKET_CLOSE" ? "CLOSE" : rule.scheduleMode === "TIME" ? rule.scheduleTime : rule.scheduleMode === "ON_DEMAND" ? "ON DEMAND" : "OPEN"}
                        </span>
                        <span className="text-xs font-mono px-2 py-0.5 rounded bg-foreground/5 text-muted-foreground">
                          {ruleTargets.length} stocks
                        </span>
                        <span className="text-xs font-mono px-2 py-0.5 rounded bg-foreground/5 text-muted-foreground">
                          {ruleMatches.length} matches
                        </span>
                        {rule.lastTriggeredAt && (
                          <span className="text-xs text-muted-foreground/60 font-mono">
                            Last: {new Date(rule.lastTriggeredAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => {
                            showIsland({
                              title: `Run ${rule.outputName || 'rule'}?`,
                              subtitle: "This will scan for matches immediately.",
                              confirmText: "Run",
                              cancelText: "Cancel",
                              onConfirm: async () => {
                                await runScreenerMutation.mutateAsync(rule.id);
                                return true;
                              },
                            });
                          }}
                          disabled={runScreenerMutation.isPending}
                          className="text-muted-foreground hover:text-bull p-2 transition-colors disabled:opacity-50"
                          title="Run now"
                        >
                          <Play className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setEditingRule(rule)}
                          className="text-muted-foreground hover:text-primary p-2 transition-colors"
                          title="Edit conditions"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => toggleRuleMutation.mutate(rule.id)}
                          className="text-muted-foreground hover:text-foreground p-2 transition-colors"
                          title={isPaused ? 'Resume' : 'Pause'}
                        >
                          {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={() => deleteRuleMutation.mutate(rule.id)}
                          className="text-muted-foreground hover:text-destructive p-2 transition-colors"
                        >
                          <Trash2 className="h-5 w-5" />
                        </button>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>

          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
