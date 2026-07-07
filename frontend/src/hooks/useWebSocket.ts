import { useEffect, useRef } from "react";
import { useStore } from "@/store/useStore";
import { normalizeMonitoringPayload } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { marketDataStore } from "@/providers/MarketDataProvider";

let activeWsSocket: WebSocket | null = null;
let pendingSymbols: string[] = [];

export function subscribeWsSymbols(symbols: string[]) {
  if (activeWsSocket?.readyState === WebSocket.OPEN && symbols && symbols.length > 0) {
    activeWsSocket.send(JSON.stringify({ event: "subscribe_symbols", data: { symbols } }));
  } else if (symbols && symbols.length > 0) {
    pendingSymbols = Array.from(new Set([...pendingSymbols, ...symbols]));
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
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let worker: Worker | null = null;
    let socketInt: WebSocket | null = null;
    let socketMd: WebSocket | null = null;

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

    const connect = (retryCount = 0) => {
      if (cancelled) return;

      clearPing();
      const nextSocketInt = new WebSocket(wsUrl("/ws/intelligence"));
      const nextSocketMd = new WebSocket(wsUrl("/ws/market-data"));
      
      nextSocketInt.binaryType = "arraybuffer";
      nextSocketMd.binaryType = "arraybuffer";
      
      socketInt = nextSocketInt;
      socketMd = nextSocketMd;
      wsRef.current = nextSocketMd; // Use MD socket for symbol subscriptions
      
      let lastMessageTimeInt = Date.now();
      let lastMessageTimeMd = Date.now();
      let isIntConnected = false;
      let isMdConnected = false;
      
      const checkConnected = () => setWsConnected(isIntConnected && isMdConnected);

      nextSocketInt.onopen = () => {
        if (cancelled) return;
        isIntConnected = true;
        checkConnected();
        lastMessageTimeInt = Date.now();
        nextSocketInt.send(JSON.stringify({ event: "subscribe", data: { topic: "system" } }));
        nextSocketInt.send(JSON.stringify({ event: "subscribe", data: { topic: "suggestions" } }));
        nextSocketInt.send(JSON.stringify({ event: "subscribe", data: { topic: "alerts" } }));
      };

      nextSocketMd.onopen = () => {
        if (cancelled) return;
        activeWsSocket = nextSocketMd;
        isMdConnected = true;
        checkConnected();
        lastMessageTimeMd = Date.now();
        nextSocketMd.send(JSON.stringify({ event: "subscribe", data: { topic: "ticks" } }));
        if (pendingSymbols.length > 0) {
          nextSocketMd.send(JSON.stringify({ event: "subscribe_symbols", data: { symbols: pendingSymbols } }));
          pendingSymbols = [];
        }
        nextSocketMd.send(JSON.stringify({ event: "subscribe", data: { topic: "monitoring" } }));
        subscribeSymbol(nextSocketMd);
      };

      const handleClose = () => {
        if (cancelled) return;
        activeWsSocket = null;
        isIntConnected = false;
        isMdConnected = false;
        checkConnected();
        wsRef.current = null;
        clearPing();
        if (socketInt && socketInt.readyState !== WebSocket.CLOSED) socketInt.close();
        if (socketMd && socketMd.readyState !== WebSocket.CLOSED) socketMd.close();

        if (!reconnectTimer) {
          const delay = Math.min(1000 * Math.pow(2, retryCount), 15000); // Exponential backoff up to 15s
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connect(retryCount + 1);
          }, delay);
        }
      };

      socketInt.onclose = handleClose;
      socketMd.onclose = handleClose;
      socketInt.onerror = handleClose;
      socketMd.onerror = handleClose;

      if (!worker) {
        worker = new Worker(new URL('../workers/marketDataWorker.ts', import.meta.url), { type: 'module' });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingTicks = new Map<string, any>();
      let rafPending = false;

      worker.onmessage = ({ data }) => {
        if (!data.ok) return;
        const { msg: event } = data;
        
        switch (event.event || event.channel) {
          case "tick_update":
            if (Array.isArray(event.data)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              event.data.forEach((t: any) => pendingTicks.set(t.symbol, t));
              if (!rafPending) {
                rafPending = true;
                requestAnimationFrame(() => {
                  const ticks = new Map(pendingTicks);
                  pendingTicks.clear();
                  rafPending = false;
                  
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
            clearScanLogs();
            setScanState({ scanning: true, current: 0, total: event.data.stocksToAnalyze });
            break;
            case "scan_progress":
              if (event.data.currentStock && event.data.status) {
                addScanLog({
                  symbol: event.data.currentStock,
                  status: event.data.status,
                  reason: event.data.reason,
                });
              }
              setScanState({
                scanning: true,
                current: event.data.current,
                total: event.data.total,
                currentStock: event.data.currentStock,
                status: event.data.status,
                reason: event.data.reason,
              });
              break;
            case "scan_completed":
              setScanState({ scanning: false });
              void queryClient.invalidateQueries({ queryKey: ["watchlist"] });
              void queryClient.invalidateQueries({ queryKey: ["suggestions"] });
              void queryClient.invalidateQueries({ queryKey: ["monitoring"] });
              void queryClient.invalidateQueries({ queryKey: ["monitored-symbols"] });
              break;
            case "monitoring_update":
              queryClient.setQueryData(
                ["monitoring"],
                normalizeMonitoringPayload(event.data),
              );
              break;
            case "new_suggestion":
              void queryClient.invalidateQueries({ queryKey: ["suggestions"] });
              useStore.getState().showIsland({
                title: `New ${event.data.direction} Signal`,
                subtitle: event.data.symbol,
                isNotification: true,
              });
              break;
            case "suggestion_updated":
              void queryClient.invalidateQueries({ queryKey: ["suggestions"] });
              break;
            case "market_regime_changed":
              void queryClient.invalidateQueries({ queryKey: ["regime"] });
              break;
            case "alert":
              void queryClient.invalidateQueries({ queryKey: ["alerts"] });
              useStore.getState().showIsland({
                title: event.data.symbol || "Alert",
                subtitle: event.data.message,
                isNotification: true,
              });
              break;
            case "system_alert":
              if (!event.data.message.toLowerCase().includes("connected to upstox")) {
                useStore.getState().showIsland({
                  title: "System Notification",
                  subtitle: event.data.message,
                  isNotification: true,
                });
              }
              break;
            case "session_state_changed":
              void queryClient.invalidateQueries({ queryKey: ["session"] });
              void queryClient.invalidateQueries({ queryKey: ["watchlist"] });
              break;
            case "indices_update":
              mergeIndices(event.data);
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

      socketInt.onmessage = (m) => handleMessage('int', m);
      socketMd.onmessage = (m) => handleMessage('md', m);

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
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      clearPing();
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        if (wsRef.current.readyState !== WebSocket.CLOSED) {
          wsRef.current.close();
        }
      }
      if (socketInt && socketInt !== wsRef.current && socketInt.readyState !== WebSocket.CLOSED) {
        socketInt.close();
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
