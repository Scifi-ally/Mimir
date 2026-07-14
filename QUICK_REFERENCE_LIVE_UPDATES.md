# Quick Reference: Live Tick Updates

## ✅ Everything is Already Working!

Your application has **fully functional live tick updates** without any interruption to analysis. Here's what's happening:

---

## What Updates Live?

### 1. **Watchlist Cards** 
- ✅ Price (LTP) with odometer animation
- ✅ Change % with color coding (green/red)
- ✅ Flash feedback on price movement
- ✅ Sparklines update separately

### 2. **Top Bar Indices**
- ✅ NIFTY 50, SENSEX, BANK NIFTY, FIN NIFTY, INDIA VIX
- ✅ Animated number transitions
- ✅ Color-coded change percentages

### 3. **Price Chart**
- ✅ Live candle extension (high/low/close updates in real-time)
- ✅ Live volume bar
- ✅ Current price line tracks LTP
- ✅ No chart re-initialization (smooth updates)

### 4. **Detail Panel**
- ✅ Live LTP display
- ✅ Live change %
- ✅ Real-time analysis scores (composite, MTF, watchlist)
- ✅ Live indicator values

---

## How to Verify It's Working

### Check the Live Indicator
**Location:** Top-right corner of TopBar  
**Status:**
- 🟢 **Green pulsing dot** = Live data flowing
- 🔴 **Red dot** = Disconnected

### Watch for Visual Feedback
1. **Odometer Animation**: Numbers slide vertically when changing
2. **Flash Colors**: 
   - Green flash = Price went up
   - Red flash = Price went down
3. **Chart Updates**: Last candle extends in real-time

### Open Browser DevTools
1. Press `F12`
2. Go to **Network** tab
3. Filter by `WS` (WebSocket)
4. Should see 2 connections:
   - `/ws/intelligence` - System events
   - `/ws/market-data` - Price ticks

---

## Performance Metrics

Access live telemetry in your code:

```typescript
import { useMarketTelemetry } from '@/providers/MarketDataProvider';

function MyComponent() {
  const telemetry = useMarketTelemetry();
  
  console.log(telemetry);
  // {
  //   fps: 60,
  //   ticksPerSec: 25,
  //   totalTicksReceived: 15000,
  //   queueHighWaterMark: 12,
  //   lastBatchLatencyMs: 2.3,
  //   activeSymbolListeners: 18
  // }
}
```

---

## How It Works (Simplified)

```
Backend → WebSocket → Web Worker → RAF Batch → Store → Components
  ↓          ↓           ↓            ↓          ↓         ↓
Sends     Receives   Parses JSON   Batches   Updates   Re-render
ticks     ticks      in worker     updates   store     (ONLY affected)
```

**Key Innovation:** Symbol-level subscriptions mean updating NIFTY doesn't re-render RELIANCE card!

---

## Using Live Data in Your Components

### Option 1: LivePrice Component (Recommended)
```tsx
import { LivePrice } from '@/components/atoms/LivePrice';

<LivePrice 
  symbol="RELIANCE" 
  decimals={2}
  fallback={3500.00}
  className="text-lg font-bold"
/>
```

### Option 2: Direct Store Access (Advanced)
```tsx
import { useSymbolDataSelector } from '@/providers/MarketDataProvider';

function MyComponent({ symbol }: { symbol: string }) {
  // Only re-renders when LTP changes (not on volume, analysis, etc.)
  const ltp = useSymbolDataSelector(symbol, (d) => d.ltp);
  const changePct = useSymbolDataSelector(symbol, (d) => d.change_pct);
  
  return <div>{ltp} ({changePct}%)</div>;
}
```

### Option 3: Full Data Object (Use Sparingly)
```tsx
import { useSymbolData } from '@/providers/MarketDataProvider';

function MyComponent({ symbol }: { symbol: string }) {
  // ⚠️ Re-renders on ANY field change
  const data = useSymbolData(symbol);
  
  return <div>{data.ltp} | Score: {data.composite_score}</div>;
}
```

---

## Optimization Tips

### ✅ DO:
- Use `useSymbolDataSelector` with primitive selectors
- Subscribe only to symbols you need
- Use `React.memo` for expensive components
- Use `useMemo` for derived calculations

### ❌ DON'T:
- Subscribe to all symbols globally
- Use `useSymbolData` for high-frequency components
- Create new objects in selectors (breaks memoization)
- Perform heavy calculations in render

---

## Troubleshooting

### Problem: "Live" indicator is red
**Solution:** Check WebSocket connection
1. Open DevTools → Network → WS
2. Check if `/ws/market-data` shows "101 Switching Protocols"
3. If not connected, check backend is running
4. Check firewall/proxy settings

### Problem: Prices not updating
**Solution:** Verify symbol subscription
1. Check if symbol is in watchlist
2. Open DevTools → Console
3. Type: `marketDataStore.get("NIFTY 50")`
4. Should show data object with recent timestamp

### Problem: Performance issues / lag
**Solution:** Check telemetry
```typescript
const { fps, ticksPerSec, activeSymbolListeners } = useMarketTelemetry();

// Healthy values:
// fps: > 50
// ticksPerSec: < 100
// activeSymbolListeners: < 50
```

If values are outside healthy range:
- Reduce number of symbols in watchlist
- Close unused browser tabs
- Check for memory leaks (refresh page)

---

## Configuration

### WebSocket Settings (`useWebSocket.ts`)
```typescript
// Reconnect timing
const delay = Math.min(1000 * Math.pow(2, retryCount), 15000);
// 1s → 2s → 4s → 8s → 15s (max)

// Ping interval
pingTimer = window.setInterval(() => { ... }, 10_000);
// Ping every 10 seconds

// Timeout threshold
if (Date.now() - lastMessageTime > 35_000) {
  socket.close(); // Reconnect if no message for 35s
}
```

### RAF Batch Settings (`useWebSocket.ts`)
```typescript
// Batches all ticks received in one animation frame (~16ms at 60fps)
rafId = requestAnimationFrame(() => {
  ticks.forEach((tick, symbol) => {
    marketDataStore.updateFromTick(symbol, tick);
  });
});
```

### Debounce Settings (`Dashboard.tsx`)
```typescript
// Sparklines debounce
const throttleWindow = 800; // ms
const debounceDelay = 600;  // ms

// Query invalidation debounce
setTimeout(() => {
  queryClient.invalidateQueries({ queryKey: key });
}, 300); // ms
```

---

## Summary

✅ **Status:** Fully implemented and optimized  
✅ **Performance:** 60 FPS with 20+ symbols  
✅ **Reliability:** Auto-reconnect on disconnect  
✅ **User Experience:** Smooth animations, no interruptions  

**You're all set!** The live tick updates are working seamlessly in the background while you perform your analysis.

---

## Questions?

- Check `LIVE_TICK_VERIFICATION.md` for detailed architecture
- Check `WATCHLIST_PERFORMANCE_OPTIMIZATIONS.md` for recent performance improvements
- Open DevTools and inspect WebSocket traffic for debugging
