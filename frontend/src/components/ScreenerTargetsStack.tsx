import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/format";
import { Card, CardHeader, CardTitle } from "@/components/mimir/card";
import { ScrollArea } from "@/components/mimir/scroll-area";
import { useStore } from "@/store/useStore";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Target, ChevronRight, ArrowLeft, Plus, Trash2, Play, Activity, Clock, Sparkles, ListTree, Settings2, Loader2 } from "lucide-react";
import { LivePrice } from "@/components/atoms/LivePrice";
import { LiveChangePct } from "@/components/atoms/LiveChangePct";
import { Sparkline } from "@/components/Sparkline";

interface ScreenerTargetsStackProps {
  selectedSymbol: string;
  sparklines?: Record<string, number[]>;
  onSelect: (symbol: string) => void;
  headerLeft?: React.ReactNode;
}

type RuleNode = {
  type: "CONDITION" | "AND" | "OR";
  indicatorA?: string;
  operator?: string;
  indicatorB?: string;
  alertMessage?: string;
  rules?: RuleNode[];
};

type ScreenerRule = {
  id: number;
  targetType: string;
  outputName?: string | null;
  timeframe?: string;
  scheduleMode?: string;
  scheduleTime?: string | null;
  status?: string;
  lastTriggeredAt?: string | null;
  createdAt?: string | null;
  conditions?: RuleNode | null;
  indicatorA?: string | null;
  operator?: string | null;
  indicatorB?: string | null;
};

type ScreenerTarget = {
  id: number;
  symbol: string;
  screenerId: number | null;
  notes?: string | null;
};

type ScreenerMatch = {
  id: number;
  screenerId: number;
  symbol: string;
  timeframe: string;
  condition: string;
  matchedAt: string;
  acknowledged: boolean;
};

const operatorLabels: Record<string, string> = {
  ">": ">",
  "<": "<",
  ">=": ">=",
  "<=": "<=",
  "==": "=",
  "!=": "!=",
  CROSSES_ABOVE: "crosses above",
  CROSSES_BELOW: "crosses below",
};

function formatShortDate(value?: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function countConditions(node?: RuleNode | null): number {
  if (!node) return 0;
  if (node.type === "CONDITION") return 1;
  return (node.rules || []).reduce((total, child) => total + countConditions(child), 0);
}

function summarizeRule(rule?: ScreenerRule) {
  if (!rule) return "No rule attached";
  if (rule.conditions) {
    const count = countConditions(rule.conditions);
    return `${count} condition${count === 1 ? "" : "s"} (${rule.conditions.type})`;
  }
  if (rule.indicatorA && rule.operator && rule.indicatorB) return `${rule.indicatorA} ${operatorLabels[rule.operator] || rule.operator} ${rule.indicatorB}`;
  return "Rule details unavailable";
}



function splitBadges(notes?: string | null) {
  if (!notes) return [];
  return notes.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 3);
}

export function ScreenerTargetsStack({ selectedSymbol, sparklines, onSelect, headerLeft }: ScreenerTargetsStackProps) {
  const queryClient = useQueryClient();
  const showIsland = useStore((s) => s.showIsland);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);

  const [activeWatchlist, setActiveWatchlist] = useState<number | null | "GLOBAL">(null);

  const { data: targets = [] } = useQuery<ScreenerTarget[]>({
    queryKey: ["screener_targets"],
    queryFn: async () => {
      const res = await fetch("/api/screener/targets");
      if (!res.ok) throw new Error("Failed to fetch targets");
      return res.json();
    },
  });

  const { data: screeners = [] } = useQuery<ScreenerRule[]>({
    queryKey: ["screener_rules"],
    queryFn: async () => {
      const res = await fetch("/api/screener");
      if (!res.ok) throw new Error("Failed to fetch screeners");
      return res.json();
    },
  });

  const { data: matches = [] } = useQuery<ScreenerMatch[]>({
    queryKey: ["screener_matches"],
    queryFn: async () => {
      const res = await fetch("/api/screener/matches");
      if (!res.ok) throw new Error("Failed to fetch screener matches");
      return res.json();
    },
  });

  const deleteTargetMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/screener/targets/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete target");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["screener_targets"] });
    },
  });

  const deleteWatchlistMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/screener/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete watchlist");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["screener_rules"] });
      queryClient.invalidateQueries({ queryKey: ["screener_targets"] });
      setActiveWatchlist(null);
    },
  });

  const runScreenerMutation = useMutation({
    mutationFn: async (screenerId?: number) => {
      const res = await fetch("/api/screener/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(screenerId ? { screenerId } : {}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || body?.message || "Failed to run screener");
      return body as { activeScreeners: number; newMatches: number; newTargets: number; totalMatches: number; totalTargets: number; runAt: string; message?: string; success: boolean };
    },
    onSuccess: async (summary) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["screener_targets"] }),
        queryClient.invalidateQueries({ queryKey: ["screener_matches"] }),
        queryClient.invalidateQueries({ queryKey: ["screener_rules"] }),
      ]);
      showIsland({
        title: summary.message ? "Screener started" : "Screener run complete",
        subtitle: summary.message || `Scanned ${summary.activeScreeners} active rule${summary.activeScreeners === 1 ? "" : "s"}. ${summary.newMatches} new match${summary.newMatches === 1 ? "" : "es"}, ${summary.newTargets} stock${summary.newTargets === 1 ? "" : "s"} added.`,
        showSuccessOnly: true,
        hideCancel: true,
      });
    },
    onError: (err) => {
      showIsland({ isNotification: true, title: "Failed to start screener", subtitle: err.message || "Failed to start screener.", showSuccessOnly: false });
    },
  });

  const customWatchlists = useMemo(() => screeners.filter((s) => s.targetType === "CUSTOM"), [screeners]);

  const targetsByWatchlist = useMemo(() => {
    const groups: Record<string, ScreenerTarget[]> = { GLOBAL: [] };
    customWatchlists.forEach((watchlist) => {
      groups[watchlist.id] = [];
    });

    targets.forEach((target) => {
      if (target.screenerId && groups[target.screenerId]) {
        groups[target.screenerId].push(target);
      } else {
        groups.GLOBAL.push(target);
      }
    });
    return groups;
  }, [targets, customWatchlists]);

  const runNow = (screenerId?: number) => {
    showIsland({
      title: screenerId ? "Run this watchlist?" : "Run screeners now?",
      subtitle: screenerId
        ? "This runs only this watchlist's active rule and refreshes matches when it finishes."
        : "This runs active screener rules immediately and refreshes matches when it finishes.",
      confirmText: "Run",
      cancelText: "Cancel",
      onConfirm: async () => {
        await runScreenerMutation.mutateAsync(screenerId);
        return true;
      },
    });
  };

  const renderTargetRow = (row: ScreenerTarget, title: string, _index: number) => {
    const selected = selectedSymbol === row.symbol;
    const badges = splitBadges(row.notes);
    return (
      <motion.div
        layout
        key={row.id}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        style={{ willChange: "transform, opacity" }}
        className={cn(
          "apple-hover flex h-[58px] items-center justify-between rounded-md px-3 py-1.5 w-full text-left transition-all relative overflow-hidden group border-0 font-mono shadow-none",
          selected
            ? "bg-secondary/50 text-foreground"
            : "bg-transparent hover:bg-secondary/20 text-foreground/85 hover:text-foreground"
        )}
      >
        <button
          role="option"
          aria-selected={selected}
          onClick={() => onSelect(row.symbol)}
          className="absolute inset-0 z-0 cursor-pointer"
        />
        <div className="flex flex-col justify-center gap-1 min-w-0 flex-1 z-10 pointer-events-none">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate text-sm font-bold tracking-tight text-foreground">{row.symbol}</span>
            <span className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider leading-none",
              row.notes ? "bg-primary/15 text-primary" : "bg-foreground/10 text-muted-foreground"
            )}>
              {row.notes ? "Rule" : "Manual"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            {badges.map((badge) => (
              <span key={badge} className="text-[11px] font-bold uppercase tracking-wider text-accent truncate">
                {badge}
              </span>
            ))}
            {badges.length === 0 && (
              <span className="text-[11px] font-medium text-foreground/60 truncate">
                {row.notes ? "Matched condition" : "Added manually"}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 z-10 shrink-0">
          <div className="flex flex-col items-end pointer-events-none">
            <LivePrice
              symbol={row.symbol}
              decimals={2}
              className="text-sm font-bold tabular-nums font-mono leading-tight text-foreground"
            />
            <LiveChangePct
              symbol={row.symbol}
              decimals={2}
              className="text-[11px] font-bold tabular-nums font-mono leading-tight"
            />
          </div>

          <button
            onClick={(e) => {
              e.stopPropagation();
              showIsland({
                title: `Remove ${row.symbol}?`,
                subtitle: `This removes ${row.symbol} from "${title}". The stock itself is not deleted.`,
                isDestructive: true,
                confirmText: "Remove",
                cancelText: "Keep",
                onConfirm: async () => {
                  await deleteTargetMutation.mutateAsync(row.id);
                  return true;
                },
              });
            }}
            className={cn(
              "rounded-full p-1.5 opacity-0 transition-opacity group-hover:opacity-100 relative z-20",
              "text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {sparklines?.[row.symbol] && (
          <div className="absolute bottom-0 left-0 right-0 h-6 opacity-30 pointer-events-none z-0">
            <Sparkline data={sparklines[row.symbol]} color={selected ? "currentColor" : undefined} />
          </div>
        )}
      </motion.div>
    );
  };

  if (activeWatchlist !== null) {
    const activeTargets = targetsByWatchlist[String(activeWatchlist)] || [];
    const activeRule = activeWatchlist === "GLOBAL" ? undefined : customWatchlists.find((w) => w.id === activeWatchlist);
    const title = activeWatchlist === "GLOBAL" ? "Uncategorized Targets" : activeRule?.outputName || "Watchlist";
    const manualTargets = activeTargets.filter((target) => !target.notes);
    const autoTargets = activeTargets.filter((target) => !!target.notes);
    const recentMatches = matches
      .filter((match) => activeWatchlist === "GLOBAL" ? true : match.screenerId === activeWatchlist)
      .slice(0, 5);

    return (
      <Card className="@container flex h-full min-h-0 flex-col border-0 bg-transparent">
        <CardHeader className="shrink-0 h-[48px] px-3 py-0 space-y-0 flex flex-row items-center justify-between gap-4 border-b border-border/10 overflow-hidden">
          {headerLeft}
          <div className="flex items-center gap-3 justify-between w-full min-w-0">
            <div className="flex items-center gap-3 min-w-0">
              <button onClick={() => setActiveWatchlist(null)} className="p-1 hover:bg-secondary/20 rounded-full transition-colors text-muted-foreground hover:text-foreground shrink-0">
                <ArrowLeft className="h-4 w-4" />
              </button>
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground truncate">
                {title}
              </CardTitle>
            </div>
            {activeWatchlist !== "GLOBAL" && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCommandPaletteOpen(true, "", activeWatchlist as number)}
                  className="flex items-center text-xs font-semibold px-2 py-1 bg-secondary/80 hover:bg-secondary text-foreground rounded transition-colors"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add Stock
                </button>
                <button
                  onClick={() => setCommandPaletteOpen(true, "", null, activeWatchlist as number)}
                  className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 bg-secondary/80 hover:bg-secondary text-foreground rounded transition-colors"
                  title="Edit scan conditions and schedule"
                >
                  <Settings2 className="h-3 w-3" />
                  Edit Rule
                </button>
                <button
                  onClick={() => runNow(activeWatchlist)}
                  disabled={runScreenerMutation.isPending}
                  className="relative flex items-center gap-1 text-xs font-bold px-3 py-1 bg-bull text-bull-foreground rounded shadow-[0_0_12px_rgba(34,197,94,0.4)] hover:shadow-[0_0_20px_rgba(34,197,94,0.7)] hover:bg-bull/90 transition-all disabled:opacity-50 z-10"
                  title="Run scan for this watchlist"
                >
                  {runScreenerMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3 fill-current" />
                  )}
                  {runScreenerMutation.isPending ? "Running..." : "Run Scan"}
                </button>
                <button
                  onClick={() => {
                    showIsland({
                      title: "Delete Watchlist?",
                      subtitle: "This will permanently remove the watchlist and all its stocks.",
                      isDestructive: true,
                      confirmText: "Delete",
                      cancelText: "Cancel",
                      onConfirm: async () => {
                        await deleteWatchlistMutation.mutateAsync(activeWatchlist as number);
                        return true;
                      },
                    });
                  }}
                  disabled={deleteWatchlistMutation.isPending}
                  className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors disabled:opacity-50"
                  title="Delete Watchlist"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </CardHeader>

        <ScrollArea className="block flex-1 min-h-0 px-2 pb-2 mt-2" role="listbox">
          <div className="flex flex-col gap-3">
            <motion.div layout className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-secondary/10 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground"><Activity className="h-3 w-3" /> Status</div>
                <div className={cn("mt-1 text-xs font-bold", activeRule?.status === "PAUSED" ? "text-amber-500" : "text-primary")}>{activeRule?.status || "ACTIVE"}</div>
              </div>
              <div className="rounded-lg bg-secondary/10 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground"><Clock className="h-3 w-3" /> Last trigger</div>
                <div className="mt-1 truncate text-xs font-bold text-foreground">{formatShortDate(activeRule?.lastTriggeredAt)}</div>
              </div>
              <div className="rounded-lg bg-secondary/10 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground"><ListTree className="h-3 w-3" /> Rule</div>
                <div className="mt-1 truncate text-xs font-bold text-foreground">{summarizeRule(activeRule)}</div>
              </div>
              <div className="rounded-lg bg-secondary/10 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground"><Sparkles className="h-3 w-3" /> Sources</div>
                <div className="mt-1 text-xs font-bold text-foreground">{autoTargets.length} auto / {manualTargets.length} manual</div>
              </div>
            </motion.div>

            {activeTargets.length === 0 ? (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center justify-center text-xs text-foreground/50 font-mono py-10 px-4 text-center">
                <Target className="h-8 w-8 mb-2 opacity-20" />
                <p>This watchlist is empty.</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <button onClick={() => setCommandPaletteOpen(true, "", activeWatchlist as number)} className="flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-[11px] font-bold text-primary-foreground transition-transform hover:scale-105">
                    <Plus className="h-3.5 w-3.5" /> Add Stock
                  </button>
                  <button onClick={() => setCommandPaletteOpen(true, "scan ")} className="flex items-center gap-1 rounded-lg bg-secondary/30 px-3 py-2 text-[11px] font-bold text-foreground transition-colors hover:bg-secondary/50">
                    <Clock className="h-3.5 w-3.5" /> Set Schedule
                  </button>
                  <button onClick={() => runNow(activeWatchlist === "GLOBAL" ? undefined : activeWatchlist)} disabled={runScreenerMutation.isPending} className="flex items-center gap-1 rounded-lg bg-secondary/30 px-3 py-2 text-[11px] font-bold text-foreground transition-colors hover:bg-secondary/50 disabled:opacity-50">
                    {runScreenerMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    {runScreenerMutation.isPending ? "Running..." : "Run Scan"}
                  </button>
                </div>
              </motion.div>
            ) : (
              <AnimatePresence>
                {autoTargets.length > 0 && (
                  <div className="flex flex-col gap-2.5">
                    <div className="px-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Auto matches</div>
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(310px,1fr))] gap-3">
                      {autoTargets.map((row, index) => renderTargetRow(row, title, index))}
                    </div>
                  </div>
                )}
                {manualTargets.length > 0 && (
                  <div className="flex flex-col gap-2.5">
                    <div className="px-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Manual stocks</div>
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(310px,1fr))] gap-3">
                      {manualTargets.map((row, index) => renderTargetRow(row, title, index))}
                    </div>
                  </div>
                )}
              </AnimatePresence>
            )}

            {recentMatches.length > 0 && (
              <motion.div layout className="mt-1 rounded-xl bg-background/30 p-3">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Recent activity</div>
                <div className="flex flex-col gap-2">
                  {recentMatches.map((match) => (
                    <div key={match.id} className="flex items-start justify-between gap-3 text-xs">
                      <div className="min-w-0 flex-1">
                        <span className="font-bold text-foreground mr-2">{match.symbol}</span>
                        <span className="text-muted-foreground break-words">{match.condition}</span>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatShortDate(match.matchedAt)}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </div>
        </ScrollArea>
      </Card>
    );
  }

  const totalCustomTargets = customWatchlists.reduce((total, watchlist) => total + (targetsByWatchlist[watchlist.id]?.length || 0), 0);
  const activeRules = customWatchlists.filter((watchlist) => watchlist.status !== "PAUSED").length;

  if (customWatchlists.length === 0) {
    return (
      <Card className="@container flex h-full min-h-0 flex-col border-0 bg-transparent">
        <CardHeader className="shrink-0 h-[48px] px-3 py-0 space-y-0 flex flex-row items-center justify-between gap-4 border-b border-border/10 overflow-hidden">
          {headerLeft}
        </CardHeader>
        <div className="flex-1 flex items-center justify-center p-6">
          <button onClick={() => setCommandPaletteOpen(true, "scan ")} className="flex items-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-xs font-bold text-primary-foreground transition-all hover:scale-105 shadow-md shadow-primary/20">
            <Plus className="h-4 w-4" /> Create Watchlist
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="@container flex h-full min-h-0 flex-col border-0 bg-transparent">
      <CardHeader className="shrink-0 h-[48px] px-3 py-0 space-y-0 flex flex-row items-center justify-between gap-4 border-b border-border/10 overflow-hidden">
        {headerLeft}
        <div className="flex items-center justify-between gap-3 w-full min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <CardTitle className="text-sm font-bold tracking-tight text-foreground whitespace-nowrap">
              Custom Watchlists
            </CardTitle>
            <div className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/80 whitespace-nowrap hidden @min-md:flex">
              <span className="text-foreground/70">{customWatchlists.length} lists</span>
              <span className="text-foreground/20">/</span>
              <span className="text-foreground/70">{totalCustomTargets} symbols</span>
              <span className="text-foreground/20">/</span>
              <span className="text-primary/90">{activeRules} active</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCommandPaletteOpen(true, "scan ")}
            className="group relative flex shrink-0 items-center gap-1.5 overflow-hidden rounded-full bg-white/5 px-4 py-1.5 text-[11px] font-bold text-foreground transition-all hover:bg-white/10 hover:shadow-[0_0_20px_rgba(255,255,255,0.1)] hover:scale-105 active:scale-95"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-primary/10 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
            <Plus className="relative h-3.5 w-3.5 text-primary" />
            <span className="relative">New</span>
          </button>
        </div>
      </CardHeader>

      <ScrollArea className="block flex-1 min-h-0 px-2 pb-2">

        <div className="flex flex-col gap-1.5 h-full">
          <AnimatePresence>
            {customWatchlists.map((watchlist) => {
            const watchlistTargets = targetsByWatchlist[watchlist.id] || [];
            const autoCount = watchlistTargets.filter((target) => !!target.notes).length;
            const isPaused = watchlist.status === "PAUSED";
            return (
              <motion.div
                layout
                key={watchlist.id}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ layout: { type: "spring", bounce: 0, duration: 0.3 } }}
                className="group flex w-full items-center justify-between rounded hover:bg-white/5 py-1 px-2 cursor-pointer transition-colors"
                onClick={() => setActiveWatchlist(watchlist.id)}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-1.5 w-1.5 items-center justify-center">
                      <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-40", isPaused ? "bg-amber-400" : "bg-primary")} />
                      <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", isPaused ? "bg-amber-400" : "bg-primary")} />
                    </span>
                    <span className="truncate text-sm font-bold tracking-tight text-foreground/90 group-hover:text-foreground">
                      {watchlist.outputName || "Unnamed Watchlist"}
                    </span>
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-muted-foreground">
                    <span className={cn("font-bold", isPaused ? "text-amber-400/80" : "text-primary/80")}>
                      {isPaused ? "PAUSED" : "ACTIVE"}
                    </span>
                    <span className="text-foreground/20">|</span>
                    <span>{watchlistTargets.length} sym</span>
                    <span className="text-foreground/20">|</span>
                    <span className={autoCount > 0 ? "text-primary" : ""}>{autoCount} matched</span>
                    <span className="text-foreground/20">|</span>
                    <span>{watchlist.timeframe || "15m"}</span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => setCommandPaletteOpen(true, "", watchlist.id)}
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-all hover:bg-white/10 hover:text-foreground"
                    title="Add stocks"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => runNow(watchlist.id)}
                    disabled={runScreenerMutation.isPending || isPaused}
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-all hover:bg-primary/20 hover:text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    title={isPaused ? "Resume this watchlist before running it" : "Run this watchlist"}
                  >
                    <Play className="h-3 w-3 fill-current ml-0.5" />
                  </button>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground ml-1" />
                </div>
              </motion.div>
            );
          })}
          </AnimatePresence>

          {targetsByWatchlist.GLOBAL?.length > 0 && (
            <button
              onClick={() => setActiveWatchlist("GLOBAL")}
              className="group flex w-full items-center justify-between rounded hover:bg-white/5 py-1 px-2 text-left transition-colors"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span className="truncate text-sm font-bold tracking-tight text-foreground/90 group-hover:text-foreground">Uncategorized Targets</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-muted-foreground">
                  <span className="text-foreground/20">|</span>
                  <span>{targetsByWatchlist.GLOBAL.length} sym</span>
                  <span className="text-foreground/20">|</span>
                  <span>Manual</span>
                </div>
              </div>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )}

        </div>
      </ScrollArea>
    </Card>
  );
}
