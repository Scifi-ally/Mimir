import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ScanProgress } from "@/types/api";

export interface ScanLog {
  id: string;
  symbol: string;
  status: string;
  reason?: string;
  time: string;
}

export type ScanPhase = "idle" | "running" | "completed" | "failed" | "stopped";

export type IslandConfig = {
  icon?: React.ReactNode;
  title: string;
  subtitle: string;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  type?: "default" | "face-id";
  showSuccessOnly?: boolean;
  hideCancel?: boolean;
  isNotification?: boolean;
  duration?: number;
  onConfirm?: () => Promise<boolean | void> | boolean | void;
  onCancel?: () => void;
};

interface AppStore {
  selectedSymbol: string;
  setSelectedSymbol: (symbol: string) => void;
  wsConnected: boolean;
  setWsConnected: (connected: boolean) => void;
  scanState: ScanProgress & { scanning: boolean; phase: ScanPhase; message?: string; updatedAt?: number };
  setScanState: (state: Partial<ScanProgress & { scanning: boolean; phase: ScanPhase; message?: string; updatedAt?: number }>) => void;
  scanLogs: ScanLog[];
  addScanLog: (log: Omit<ScanLog, "id" | "time">) => void;
  clearScanLogs: () => void;
  latestAlert: string | null;
  setLatestAlert: (message: string | null) => void;
  indices: Record<string, { ltp: number | null; changePct: number | null }>;
  mergeIndices: (data: Record<string, { ltp: number | null; changePct: number | null }>) => void;
  islandConfig: IslandConfig | null;
  showIsland: (config: IslandConfig) => void;
  hideIsland: () => void;
  commandPaletteOpen: boolean;
  commandPaletteSearch: string;
  commandPaletteTargetWatchlist: number | null;
  commandPaletteEditRuleId: number | null;
  setCommandPaletteOpen: (open: boolean, search?: string, targetWatchlist?: number | null, editRuleId?: number | null) => void;
  watchlistCounts: Record<string, number>;
  updateWatchlistCounts: (counts: Record<string, number>) => void;
  layoutMode: "comfortable" | "compact";
  setLayoutMode: (mode: "comfortable" | "compact") => void;
  theme: "dark" | "light" | "quant";
  setTheme: (theme: "dark" | "light" | "quant") => void;
}

export const useStore = create<AppStore>()(
  persist(
    (set) => ({
      selectedSymbol: "",
      setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
      wsConnected: false,
      setWsConnected: (connected) => set({ wsConnected: connected }),
      layoutMode: "comfortable",
      setLayoutMode: (mode) => set({ layoutMode: mode }),
      theme: "dark",
      setTheme: (theme) => set({ theme }),
      scanState: { scanning: false, current: 0, total: 0, phase: "idle" },
  setScanState: (partial) =>
    set((state) => ({
      scanState: { ...state.scanState, ...partial },
    })),
  scanLogs: [],
  addScanLog: (log) => set((state) => {
    const lastLog = state.scanLogs[0];
    // If it's the exact same symbol and status, ignore it
    if (lastLog && lastLog.symbol === log.symbol && lastLog.status === log.status && lastLog.reason === log.reason) {
      return state;
    }
    if (lastLog && lastLog.symbol === log.symbol) {
      const updatedLog: ScanLog = { ...log, id: lastLog.id, time: new Date().toLocaleTimeString() };
      return { scanLogs: [updatedLog, ...state.scanLogs.slice(1)] };
    }
    // Otherwise add as new
    const newLog: ScanLog = { ...log, id: crypto.randomUUID(), time: new Date().toLocaleTimeString() };
    return { scanLogs: [newLog, ...state.scanLogs].slice(0, 50) };
  }),
  clearScanLogs: () => set({ scanLogs: [] }),
  latestAlert: null,
  setLatestAlert: (message) => set({ latestAlert: message }),
  indices: {},
  mergeIndices: (data) =>
    set((state) => ({ indices: { ...state.indices, ...data } })),
  islandConfig: null,
  showIsland: (config) => set({ islandConfig: config }),
  hideIsland: () => set({ islandConfig: null }),
  commandPaletteOpen: false,
  commandPaletteSearch: "",
  commandPaletteTargetWatchlist: null,
  commandPaletteEditRuleId: null,
  setCommandPaletteOpen: (open, search = "", targetWatchlist = null, editRuleId = null) =>
    set({
      commandPaletteOpen: open,
      commandPaletteSearch: search,
      commandPaletteTargetWatchlist: targetWatchlist,
      commandPaletteEditRuleId: editRuleId,
    }),
  watchlistCounts: {},
  updateWatchlistCounts: (counts) => set((state) => ({ watchlistCounts: { ...state.watchlistCounts, ...counts } })),
    }),
    {
      name: "mimir-store",
      partialize: (state) => ({
        selectedSymbol: state.selectedSymbol,
      }),
    }
  )
);

import { useShallow } from "zustand/react/shallow";

// Watchlist counts — changes on scan
export const useWatchlistCounts = () => 
  useStore(useShallow(s => s.watchlistCounts));

// Active symbol — changes on user click
export const useActiveSymbol = () => useStore(s => s.selectedSymbol);
export const useSetActiveSymbol = () => useStore(s => s.setSelectedSymbol);
