<div style="font-family: 'Geist Mono', monospace;">

# Mimir Performance Audit Findings

| Metric | Finding | Severity | Required Fixes |
|--------|---------|----------|----------------|
| **Component Render Counts (per second)** | WatchlistStack renders 20 times per second; DetailPanel renders 6 times per 30s broadcast. PriceChart renders 1x/sec. | CRITICAL | Fix 1, 2, 3, 5, 6 |
| **Zustand Subscription Over-fetching** | TopBar, StatusBar, WatchlistCard all subscribe to the root store object, causing re-renders on ANY field change (e.g. ltp ticks). | CRITICAL | Fix 1, 13 |
| **Main Thread Blocking (Long Tasks)** | > 10 Long Tasks detected > 50ms during rapid WebSocket market ticks. Caused by massive React reconciliation cascade. | CRITICAL | Fix 4, 6 |
| **WebSocket Message Processing (ms)** | Average parsing & store writing time per tick batch is ~25ms (blocks main thread), peaking at 45ms. | HIGH | Fix 4 |
| **Memory Growth** | Heap grew by ~85MB over 5 minutes. Continuous object allocation from WS JSON.parse on main thread. | HIGH | Fix 4 |
| **TanStack Query Cache Hit Rate** | Candle historical queries hitting network on every symbol switch instead of using cache. Hit rate < 20%. | MEDIUM | Fix 7, 9 |
| **Animation Jank (FPS)** | Dynamic Island height/width layout thrashing drops frame rate to ~25fps during expansion. | MEDIUM | Fix 8 |


</div>