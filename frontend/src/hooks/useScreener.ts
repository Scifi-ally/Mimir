import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@/store/useStore";

export type RuleNode = {
  type: "CONDITION" | "AND" | "OR";
  indicatorA?: string;
  operator?: string;
  indicatorB?: string;
  alertMessage?: string;
  rules?: RuleNode[];
};

export type ScreenerRule = {
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

export type ScreenerTarget = {
  id: number;
  symbol: string;
  screenerId: number | null;
  notes?: string | null;
};

export type ScreenerMatch = {
  id: number;
  screenerId: number;
  symbol: string;
  timeframe: string;
  condition: string;
  matchedAt: string;
  acknowledged: boolean;
};

export function useScreener() {
  const queryClient = useQueryClient();
  const showIsland = useStore((s) => s.showIsland);

  const targetsQuery = useQuery<ScreenerTarget[]>({
    queryKey: ["screener_targets"],
    queryFn: async () => {
      const res = await fetch("/api/screener/targets");
      if (!res.ok) throw new Error("Failed to fetch targets");
      return res.json();
    },
  });

  const screenersQuery = useQuery<ScreenerRule[]>({
    queryKey: ["screener_rules"],
    queryFn: async () => {
      const res = await fetch("/api/screener");
      if (!res.ok) throw new Error("Failed to fetch screeners");
      return res.json();
    },
  });

  const matchesQuery = useQuery<ScreenerMatch[]>({
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
      queryClient.invalidateQueries({ queryKey: ["screener_matches"] });
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
      queryClient.invalidateQueries({ queryKey: ["screener_matches"] });
      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
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
        queryClient.invalidateQueries({ queryKey: ["watchlist"] }),
        queryClient.invalidateQueries({ queryKey: ["customWatchlist"] }),
        queryClient.invalidateQueries({ queryKey: ["suggestions"] }),
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

  return {
    targetsQuery,
    screenersQuery,
    matchesQuery,
    deleteTargetMutation,
    deleteWatchlistMutation,
    runScreenerMutation,
  };
}
