import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ScanProgress } from "@/types/api";
import CryptoJS from "crypto-js";

const PIN_ENCRYPTION_KEY = "mimir-secure-pin-key-2026";

// crypto.randomUUID requires a secure context — undefined when the dashboard
// is opened over plain http:// on a LAN IP. IDs here only key React lists.
function uid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ScanLog {
  id: string;
  symbol: string;
  status: string;
  reason?: string;
  time: string;
}

export type ScanPhase = "idle" | "running" | "completed" | "failed" | "stopped";

export interface AppEvent {
  id: string;
  type: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
  timestamp: string;
  symbol?: string;
}

export type IslandConfig = {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  content?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  type?: "default" | "face-id";
  showSuccessOnly?: boolean;
  hideCancel?: boolean;
  isNotification?: boolean;
  isLocked?: boolean;
  forceOverride?: boolean;
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
  setScanLogs: (logs: ScanLog[]) => void;
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
  eventFeedOpen: boolean;
  setEventFeedOpen: (open: boolean) => void;
  events: AppEvent[];
  addEvent: (event: Omit<AppEvent, "id" | "timestamp">) => void;
  clearEvents: () => void;
  layoutMode: "comfortable" | "compact";
  setLayoutMode: (mode: "comfortable" | "compact") => void;
  theme: "dark" | "light" | "quant";
  setTheme: (theme: "dark" | "light" | "quant") => void;
  saveMobileNumber: boolean;
  setSaveMobileNumber: (save: boolean) => void;
  savedMobileNumber: string;
  setSavedMobileNumber: (number: string) => void;
  savePin: boolean;
  setSavePin: (save: boolean) => void;
  savedPin: string;
  setSavedPin: (pin: string) => void;
  getDecryptedPin: () => string;
}

export const useStore = create<AppStore>()(
  persist(
    (set, get) => ({
      // Default to NIFTY 50 (a valid index selection) so the chart/insights queries
      // fire in parallel with the watchlist query on first-ever load instead of
      // waiting for the watchlist round-trip. Persisted selections override this.
      selectedSymbol: "NIFTY 50",
      setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
      wsConnected: false,
      setWsConnected: (connected) => set({ wsConnected: connected }),
      layoutMode: "comfortable",
      setLayoutMode: (mode) => set({ layoutMode: mode }),
      theme: "dark",
      setTheme: (theme) => set({ theme }),
      saveMobileNumber: false,
      setSaveMobileNumber: (save) => set({ saveMobileNumber: save }),
      savedMobileNumber: "",
      setSavedMobileNumber: (number) => set({ savedMobileNumber: number }),
      savePin: false,
      setSavePin: (save) => set({ savePin: save }),
      savedPin: "",
      setSavedPin: (pin) => {
        if (!pin) {
          set({ savedPin: "" });
        } else {
          try {
            const encrypted = CryptoJS.AES.encrypt(pin, PIN_ENCRYPTION_KEY).toString();
            set({ savedPin: encrypted });
          } catch {
            set({ savedPin: "" });
          }
        }
      },
      getDecryptedPin: () => {
        const { savedPin } = get();
        if (!savedPin) return "";
        try {
          const bytes = CryptoJS.AES.decrypt(savedPin, PIN_ENCRYPTION_KEY);
          return bytes.toString(CryptoJS.enc.Utf8) || "";
        } catch {
          return "";
        }
      },
      scanState: { scanning: false, current: 0, total: 0, phase: "idle" },
  setScanState: (partial) =>
    set((state) => ({
      scanState: { ...state.scanState, ...partial },
    })),
  scanLogs: [],
  // MEDIUM FIX (Issue #19): Improved scan log deduplication
  // Previous code only checked first log, now checks entire array
  addScanLog: (log) => set((state) => {
    // Find existing log for this symbol in entire array
    const existingIndex = state.scanLogs.findIndex(
      l => l.symbol === log.symbol
    );
    
    if (existingIndex >= 0) {
      const existingLog = state.scanLogs[existingIndex];
      
      // If status and reason unchanged, no update needed
      if (existingLog.status === log.status && existingLog.reason === log.reason) {
        return state;
      }
      
      // Update existing log with new ID and timestamp
      const newLogs = [...state.scanLogs];
      newLogs[existingIndex] = {
        ...log,
        id: uid(), // New ID for React key change detection
        time: new Date().toISOString() // Use ISO timestamp instead of locale string
      };
      return { scanLogs: newLogs.slice(0, 50) };
    }
    
    // Add new log
    const newLog: ScanLog = { 
      ...log, 
      id: uid(),
      time: new Date().toISOString() 
    };
    return { scanLogs: [newLog, ...state.scanLogs].slice(0, 50) };
  }),
  setScanLogs: (logs) => set({ scanLogs: logs }),
  clearScanLogs: () => set({ scanLogs: [] }),
  latestAlert: null,
  setLatestAlert: (message) => set({ latestAlert: message }),
  indices: {},
  mergeIndices: (data) =>
    set((state) => ({ indices: { ...state.indices, ...data } })),
  islandConfig: null,
  showIsland: (config) => set((state) => {
    if (state.islandConfig?.isLocked && !config.forceOverride && config.title !== "") {
      return state;
    }
    return { islandConfig: config };
  }),
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
  eventFeedOpen: false,
  setEventFeedOpen: (open) => set({ eventFeedOpen: open }),
  events: [],
  addEvent: (event) => set((state) => ({
    events: [
      {
        ...event,
        id: uid(),
        timestamp: new Date().toISOString(),
      },
      ...state.events,
    ].slice(0, 100), // Keep last 100 events
  })),
  clearEvents: () => set({ events: [] }),
    }),
    {
      name: "mimir-store-v2",
      partialize: (state) => ({
        selectedSymbol: state.selectedSymbol,
        layoutMode: state.layoutMode,
        theme: state.theme,
        saveMobileNumber: state.saveMobileNumber,
        savedMobileNumber: state.savedMobileNumber,
        savePin: state.savePin,
        savedPin: state.savedPin,
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
