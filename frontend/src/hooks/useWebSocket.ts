import { useEffect, useRef } from "react";
import { useStore } from "@/store/useStore";
import { normalizeMonitoringPayload } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { marketDataStore } from "@/providers/MarketDataProvider";

let activeWsSocket: WebSocket | null = null;
let pendingSymbols: string[] = [];
const currentSubscribedSymbols = new Set<string>();
let lastSubscribedSymbolsKey = "";

export function subscribeWsSymbols(symbols: string[]) {
  if (!symbols || !Array.isArray(symbols)) return;
  const cleanSymbols = symbols.map(s => typeof s === "string" ? s.trim() : "").filter(Boolean);
  cleanSymbols.forEach(s => currentSubscribedSymbols.add(s));

  const toSubscribe = Array.from(currentSubscribedSymbols);
  const newKey = toSubscribe.sort().join(",");
  if (newKey === lastSubscribedSymbolsKey && activeWsSocket?.readyState === WebSocket.OPEN) return;
  lastSubscribedSymbolsKey = newKey;

  if (activeWsSocket?.readyState === WebSocket.OPEN && toSubscribe.length > 0) {
    activeWsSocket.send(JSON.stringify({ event: "subscribe_symbols", data: { symbols: toSubscribe } }));
  } else if (toSubscribe.length > 0) {
    pendingSymbols = Array.from(new Set([...pendingSymbols, ...toSubscribe]));
  }
}

function wsUrl(path = "/ws") {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

export function useWebSocket() {
  const setWsConnected = useStore((s) => s.setWsConnected);
  const setScanState = useStore((s) => s.setScanState);
  const addScanLog = useStore((s) => s.addScanLog);
  const clearScanLogs = useStore((s) => s.clearScanLogs);
  const updateWatchlistCounts = useStore((s) => s.updateWatchlistCounts);
  const mergeIndices = useStore((s) => s.mergeIndices);
  const selectedSymbol = useStore((s) => s.selectedSymbol);
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const selectedSymbolRef = useRef(selectedSymbol);

  useEffect(() => {
    selectedSymbolRef.current = selectedSymbol;
  }, [selectedSymbol]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimerInt: number | null = null;
    let reconnectTimerMd: number | null = null;
    let pingTimer: number | null = null;
    let worker: Worker | null = null;
    let socketInt: WebSocket | null = null;
    let socketMd: WebSocket | null = null;
    
    // Use a dictionary to debounce invalidations of specific query keys
    const invalidationTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};
    const debouncedInvalidate = (key: string[]) => {
      const keyStr = key.join("-");
      if (invalidationTimeouts[keyStr]) clearTimeout(invalidationTimeouts[keyStr]);
      invalidationTimeouts[keyStr] = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: key });
      }, 300);
    };
    // Throttle scan_progress: the backend emits multiple events per scanned
    // stock, so batch store updates every ~250ms (mirrors debouncedInvalidate)
    // instead of forcing a re-render per message. STOPPED still flushes
    // immediately below.
    let scanFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingScanState: Parameters<typeof setScanState>[0] | null = null;
    const pendingScanLogs = new Map<string, Parameters<typeof addScanLog>[0]>();
    const flushScanProgress = () => {
      scanFlushTimer = null;
      pendingScanLogs.forEach((log) => addScanLog(log));
      pendingScanLogs.clear();
      if (pendingScanState) {
        setScanState(pendingScanState);
        pendingScanState = null;
      }
    };
    const scheduleScanFlush = () => {
      if (scanFlushTimer === null) {
        scanFlushTimer = setTimeout(flushScanProgress, 250);
      }
    };
    const cancelScanFlush = () => {
      if (scanFlushTimer !== null) {
        clearTimeout(scanFlushTimer);
        scanFlushTimer = null;
      }
      pendingScanState = null;
      pendingScanLogs.clear();
    };
    let isMdConnected = false;
    let lastMessageTimeInt = Date.now();
    let lastMessageTimeMd = Date.now();

    // The dashboard's "Live" indicator describes the price feed. Intelligence
    // events may reconnect independently without making displayed ticks stale.
    const checkConnected = () => setWsConnected(isMdConnected);

    const clearPing = () => {
      if (pingTimer != null) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const subscribeSymbol = (ws: WebSocket) => {
      const symbol = selectedSymbolRef.current.trim();
      if (symbol) {
        ws.send(JSON.stringify({ event: "subscribe_symbol", data: { symbol } }));
      }
    };
    
    const sendAuth = (ws: WebSocket) => {
      const token = localStorage.getItem("mimir_admin_token");
      if (token) {
        ws.send(JSON.stringify({ event: "auth", data: { token } }));
      }
    };

    const connectInt = (retryCount = 0) => {
      if (cancelled) return;
      const nextSocketInt = new WebSocket(wsUrl("/ws/intelligence"));
      nextSocketInt.binaryType = "arraybuffer";
      socketInt = nextSocketInt;
      lastMessageTimeInt = Date.now();

      nextSocketInt.onopen = () => {
        if (cancelled) return;
        sendAuth(nextSocketInt);
        checkConnected();
        lastMessageTimeInt = Date.now();
        nextSocketInt.send(JSON.stringify({ event: "subscribe", data: { topic: "system" } }));
        nextSocketInt.send(JSON.stringify({ event: "subscribe", data: { topic: "suggestions" } }));
        nextSocketInt.send(JSON.stringify({ event: "subscribe", data: { topic: "alerts" } }));
        void queryClient.invalidateQueries({ queryKey: ["scan-status"] });
        void queryClient.invalidateQueries({ queryKey: ["monitoring"] });
        void queryClient.invalidateQueries({ queryKey: ["suggestions"] });
      };

      const handleCloseInt = () => {
        if (cancelled) return;
        checkConnected();
        if (socketInt && socketInt.readyState !== WebSocket.CLOSED) socketInt.close();

        if (!reconnectTimerInt) {
          const delay = Math.min(1000 * Math.pow(2, retryCount), 15000);
          reconnectTimerInt = window.setTimeout(() => {
            reconnectTimerInt = null;
            connectInt(retryCount + 1);
          }, delay);
        }
      };

      nextSocketInt.onclose = handleCloseInt;
      nextSocketInt.onerror = handleCloseInt;
      nextSocketInt.onmessage = (m) => handleMessage('int', m);
    };

    const connectMd = (retryCount = 0) => {
      if (cancelled) return;
      const nextSocketMd = new WebSocket(wsUrl("/ws/market-data"));
      nextSocketMd.binaryType = "arraybuffer";
      socketMd = nextSocketMd;
      wsRef.current = nextSocketMd;
      activeWsSocket = nextSocketMd;
      lastMessageTimeMd = Date.now();

      nextSocketMd.onopen = () => {
        if (cancelled) return;
        sendAuth(nextSocketMd);
        isMdConnected = true;
        checkConnected();
        lastMessageTimeMd = Date.now();
        nextSocketMd.send(JSON.stringify({ event: "subscribe", data: { topic: "ticks" } }));
        const allSymbols = Array.from(new Set([...Array.from(currentSubscribedSymbols), ...pendingSymbols]));
        if (allSymbols.length > 0) {
          nextSocketMd.send(JSON.stringify({ event: "subscribe_symbols", data: { symbols: allSymbols } }));
          pendingSymbols = [];
          lastSubscribedSymbolsKey = allSymbols.sort().join(",");
        }
        nextSocketMd.send(JSON.stringify({ event: "subscribe", data: { topic: "monitoring" } }));
        subscribeSymbol(nextSocketMd);
        void queryClient.invalidateQueries({ queryKey: ["indices"] });
      };

      const handleCloseMd = () => {
        if (cancelled) return;
        if (activeWsSocket === socketMd) activeWsSocket = null;
        if (wsRef.current === socketMd) wsRef.current = null;
        lastSubscribedSymbolsKey = "";
        isMdConnected = false;
        checkConnected();
        if (socketMd && socketMd.readyState !== WebSocket.CLOSED) socketMd.close();

        if (!reconnectTimerMd) {
          const delay = Math.min(1000 * Math.pow(2, retryCount), 15000);
          reconnectTimerMd = window.setTimeout(() => {
            reconnectTimerMd = null;
            connectMd(retryCount + 1);
          }, delay);
        }
      };

      nextSocketMd.onclose = handleCloseMd;
      nextSocketMd.onerror = handleCloseMd;
      nextSocketMd.onmessage = (m) => handleMessage('md', m);
    };

      if (!worker) {
        worker = new Worker(new URL('../workers/marketDataWorker.ts', import.meta.url), { type: 'module' });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingTicks = new Map<string, any>();
      let rafId: number | null = null;

      worker.onmessage = ({ data }) => {
        if (!data.ok) return;
        const { msg: event } = data;
        
        switch (event.event || event.channel) {
          case "tick_update":
            if (Array.isArray(event.data)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              event.data.forEach((t: any) => pendingTicks.set(t.symbol, t));
              if (rafId === null) {
                rafId = requestAnimationFrame(() => {
                  const ticks = new Map(pendingTicks);
                  pendingTicks.clear();
                  rafId = null;
                  
                  ticks.forEach((tick, symbol) => {
                    marketDataStore.updateFromTick(symbol, tick);
                  });
                });
              }
            }
            break;
          case "worker_telemetry":
            marketDataStore.updateTelemetry(event.data);
            break;
          case "market:tick":
            marketDataStore.updateFromTick(event.data.symbol, event.data);
            break;
          case "market:analysis":
            marketDataStore.updateFromAnalysis(event.data.symbol, event.data);
            break;
          case "scan_started":
            cancelScanFlush();
            clearScanLogs();
            setScanState({ scanning: true, phase: "running", current: 0, total: event.data.stocksToAnalyze, message: "Scanner started", updatedAt: Date.now() });
            break;
            case "scan_progress":
              // If status is STOPPED, reset the scan state immediately
              if (event.data.status === "STOPPED") {
                cancelScanFlush();
                setScanState({
                  scanning: false,
                  phase: "stopped",
                  current: 0,
                  total: 0,
                  currentStock: "",
                  status: "STOPPED",
                  reason: "Scan manually stopped",
                  message: "Scan manually stopped",
                  updatedAt: Date.now(),
                });
                clearScanLogs();
              } else {
                if (event.data.currentStock && event.data.status) {
                  pendingScanLogs.set(event.data.currentStock, {
                    symbol: event.data.currentStock,
                    status: event.data.status,
                    reason: event.data.reason,
                  });
                }
                pendingScanState = {
                  scanning: true,
                  phase: "running",
                  current: event.data.current,
                  total: event.data.total,
                  currentStock: event.data.currentStock,
                  status: event.data.status,
                  reason: event.data.reason,
                  message: event.data.reason || event.data.status || "Scanning",
                  updatedAt: Date.now(),
                };
                scheduleScanFlush();
              }
              break;
            case "scan_completed":
              {
                // Flush buffered logs so the panel is complete, but drop any
                // queued "running" state so it can't overwrite the final one.
                if (scanFlushTimer !== null) {
                  clearTimeout(scanFlushTimer);
                  scanFlushTimer = null;
                }
                pendingScanState = null;
                flushScanProgress();
                const phase = event.data.outcome === "FAILED"
                  ? "failed"
                  : event.data.outcome === "STOPPED"
                    ? "stopped"
                    : "completed";
                setScanState({
                  scanning: false,
                  phase,
                  current: 0,
                  total: 0,
                  message: event.data.message || (phase === "completed" ? "Scan completed" : `Scan ${phase}`),
                  updatedAt: Date.now(),
                });
                // Also clear the optimistic scanRunning flag in session cache
                queryClient.setQueryData(["session"], (old: any) => old ? { ...old, scanRunning: false } : old);
                // Clear scan logs when scan completes or is stopped
                if (phase === "stopped") {
                  clearScanLogs();
                }
              }
              debouncedInvalidate(["watchlist"]);
              debouncedInvalidate(["suggestions"]);
              debouncedInvalidate(["monitoring"]);
              debouncedInvalidate(["monitored-symbols"]);
              break;
            case "monitoring_update":
              queryClient.setQueryData(
                ["monitoring"],
                normalizeMonitoringPayload(event.data),
              );
              break;
            case "new_suggestion":
              debouncedInvalidate(["suggestions"]);
              useStore.getState().showIsland({
                title: `New ${event.data.direction} Signal`,
                subtitle: event.data.symbol,
                isNotification: true,
              });
              useStore.getState().addEvent({
                type: "success",
                title: `New ${event.data.direction} Signal`,
                message: `AI generated a new trading signal.`,
                symbol: event.data.symbol,
              });
              break;
            case "suggestion_updated":
              debouncedInvalidate(["suggestions"]);
              break;
            case "position_update":
              // Trailing-stop / manual-close updates from position_tracker
              debouncedInvalidate(["suggestions"]);
              debouncedInvalidate(["positions"]);
              // Paper panel data is WS-driven now, so its polling can stay slow
              debouncedInvalidate(["paperTrading"]);
              break;
            case "daily_loss_limit_reached":
              debouncedInvalidate(["suggestions"]);
              useStore.getState().addEvent({
                type: "warning",
                title: "Loss Limit Reached",
                message: `Daily loss limit hit — new suggestions paused.`,
              });
              break;
            case "market_regime_changed":
              debouncedInvalidate(["regime"]);
              break;
            case "alert":
              debouncedInvalidate(["alerts"]);
              useStore.getState().addEvent({
                type: "warning",
                title: event.data.symbol ? "Alert Triggered" : "System Alert",
                message: event.data.message,
                symbol: event.data.symbol,
              });
              break;
            case "system_alert":
              {
                const msgText = event.data.message || "";
                const lower = msgText.toLowerCase();
                const isLiveOrderEvent = lower.startsWith("live ");
                const isModeChange = lower.includes("live trading armed") || lower.includes("live trading disarmed");

                if (isLiveOrderEvent || isModeChange) {
                  // Real-money events get first-class island treatment and
                  // refresh the live panel + mode badge immediately.
                  useStore.getState().showIsland({
                    title: isModeChange
                      ? (lower.includes("armed") ? "Live Trading Armed" : "Live Trading Disarmed")
                      : lower.includes("failed") ? "Live Order Failed" : "Live Order Placed",
                    subtitle: msgText,
                    isNotification: true,
                  });
                  useStore.getState().addEvent({
                    type: lower.includes("failed") ? "warning" : "info",
                    title: isModeChange ? "Trading Mode" : "Live Order",
                    message: msgText,
                  });
                  debouncedInvalidate(["trading-mode"]);
                  debouncedInvalidate(["live", "orders"]);
                  debouncedInvalidate(["live", "positions"]);
                  debouncedInvalidate(["live", "funds"]);
                  break;
                }

                if (!lower.includes("connected to upstox")) {
                  useStore.getState().showIsland({
                    title: "System Notification",
                    subtitle: msgText,
                    isNotification: true,
                  });
                }
                useStore.getState().addEvent({
                  type: "info",
                  title: "System Notification",
                  message: msgText,
                });
                // Safety net: if the alert is about a scan failure, force-reset scan state
                if (lower.includes("scanner failed") || lower.includes("scan failed")) {
                  setScanState({ scanning: false, phase: "failed", current: 0, total: 0, message: msgText, updatedAt: Date.now() });
                  queryClient.setQueryData(["session"], (old: any) => old ? { ...old, scanRunning: false } : old);
                }
              }
              break;
            case "session_state_changed":
              debouncedInvalidate(["session"]);
              debouncedInvalidate(["watchlist"]);
              break;
            case "indices_update":
              mergeIndices(event.data);
              if (event.data.nifty?.ltp != null) marketDataStore.updateFromTick("NIFTY 50", { ltp: event.data.nifty.ltp, change_pct: event.data.nifty.changePct });
              if (event.data.sensex?.ltp != null) marketDataStore.updateFromTick("SENSEX", { ltp: event.data.sensex.ltp, change_pct: event.data.sensex.changePct });
              if (event.data.banknifty?.ltp != null) marketDataStore.updateFromTick("BANK NIFTY", { ltp: event.data.banknifty.ltp, change_pct: event.data.banknifty.changePct });
              if (event.data.finnifty?.ltp != null) marketDataStore.updateFromTick("FIN NIFTY", { ltp: event.data.finnifty.ltp, change_pct: event.data.finnifty.changePct });
              if (event.data.vix?.ltp != null) marketDataStore.updateFromTick("INDIA VIX", { ltp: event.data.vix.ltp, change_pct: event.data.vix.changePct });
              break;
            case "watchlist_counts":
              updateWatchlistCounts(event.data);
              break;
            default:
              break;
          }
      };

      const handleMessage = (source: 'int' | 'md', message: MessageEvent) => {
        if (cancelled) return;
        if (source === 'int') lastMessageTimeInt = Date.now();
        if (source === 'md') lastMessageTimeMd = Date.now();
        if (worker) {
          worker.postMessage(message.data); // Offload JSON.parse and processing
        }
      };

      // Duplicate setInterval removed
    connectInt();
    connectMd();

    pingTimer = window.setInterval(() => {
      if (socketInt?.readyState === WebSocket.OPEN) {
        if (Date.now() - lastMessageTimeInt > 35_000) {
          socketInt.close();
        } else {
          socketInt.send(JSON.stringify({ event: "ping" }));
        }
      }
      if (socketMd?.readyState === WebSocket.OPEN) {
        if (Date.now() - lastMessageTimeMd > 35_000) {
          socketMd.close();
        } else {
          socketMd.send(JSON.stringify({ event: "ping" }));
        }
      }
    }, 10_000);

    return () => {
      cancelled = true;
      Object.values(invalidationTimeouts).forEach(clearTimeout);
      cancelScanFlush();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (reconnectTimerInt != null) window.clearTimeout(reconnectTimerInt);
      if (reconnectTimerMd != null) window.clearTimeout(reconnectTimerMd);
      clearPing();
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        if (wsRef.current.readyState === WebSocket.CONNECTING) {
          const currentWs = wsRef.current;
          currentWs.onopen = () => currentWs.close();
        } else if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.close();
        }
      }
      if (socketInt && socketInt !== wsRef.current) {
        if (socketInt.readyState === WebSocket.CONNECTING) {
          socketInt.onopen = () => socketInt?.close();
        } else if (socketInt.readyState === WebSocket.OPEN) {
          socketInt.close();
        }
      }
      if (socketMd && socketMd !== wsRef.current) {
        if (socketMd.readyState === WebSocket.CONNECTING) {
          socketMd.onopen = () => socketMd?.close();
        } else if (socketMd.readyState === WebSocket.OPEN) {
          socketMd.close();
        }
      }
      wsRef.current = null;
      if (worker) {
        worker.terminate();
      }
    };
  }, [mergeIndices, queryClient, setScanState, setWsConnected, addScanLog, clearScanLogs, updateWatchlistCounts]);

  useEffect(() => {
    const ws = wsRef.current;
    const symbol = selectedSymbol.trim();
    if (ws?.readyState === WebSocket.OPEN && symbol) {
      ws.send(JSON.stringify({ event: "subscribe_symbol", data: { symbol } }));
    }
    
    return () => {
      if (ws?.readyState === WebSocket.OPEN && symbol) {
        ws.send(JSON.stringify({ event: "unsubscribe_symbol", data: { symbol } }));
      }
    };
  }, [selectedSymbol]);
}
