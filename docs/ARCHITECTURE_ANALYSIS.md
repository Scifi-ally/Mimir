<div style="font-family: 'Geist Mono', monospace;">

# Mimir Architecture Analysis: Symbol Selection & Data Flow

## EXECUTIVE SUMMARY

Two architectural issues prevent the UI from properly locking to a single monitored symbol and cause panels to display "--" for fields that should be live-updating:

### Issue #1: Multi-Symbol Chart Confusion (PART 1)
Users can select any of ~92 NSE stocks, but only ~30 are actively monitored. This creates false expectations: a chart opens, but no live signals/monitoring is happening because the symbol isn't in `overnightWatchlist`. The UI needs to:
1. Lock to a single "active symbol" concept  
2. Filter ticks to only active symbol (client-side + server awareness)
3. Show clear UX state when symbol not monitored

### Issue #2: Data Stuck on "--" (PART 2)
Several fields show "--" even when WS shows "LIVE", including:
- **AI Outlook:** Signal, Entry, Active Bias, Score
- **Risk Matrix:** Stop loss invalidation level
- **Trade Ticket:** Entry/Stop/Target/Risk Reward/Qty
- **Top Bar Indices:** NIFTY, BANKNIFTY, FINNIFTY, SENSEX, VIX, Breadth

Daily PnL and Active Exposure update correctly, so WebSocket works for some data. This indicates selective data flow failures, not total connection loss.

---

## DETAILED ANALYSIS

### Current Architecture

```

                        FRONTEND (React/Vite)                         

                                                                       
  Dashboard.tsx (main page)                                           
   selectedSymbol (Zustand) ← any of ~92 stocks              
                                                                 
   useWebSocket() hook                                         
     listens to all events, updates Zustand                  
        tick_update → setLatestTickBatch([all symbols])     
        new_suggestion → query invalidation                  
                                                                 
   useGetActiveSuggestions() (React Query)                    
     /api/suggestions/active (polled every 10s)             
     Returns ALL active suggestions across ALL symbols      
     activeRecommendation = find(s => s.symbol == selected) 
                                                                 
   UI Components                                               
     AI Outlook        ← uses activeRecommendation         
     Risk Matrix       ← uses activeRecommendation         
     Trade Ticket      ← uses activeRecommendation         
     PriceChart        ← uses latestTickBatch (all symbols) 
     Top Bar Indices   ← uses indices state (polled)       
                                                                 
   Symbol selection logic                                      
      Search results → setSelectedSymbol(symbol)             
      Watchlist click → setSelectedSymbol(symbol)            
      Scanner click → setSelectedSymbol(symbol)              
                                                                  

                                
                     WebSocket (to /ws)
                                

                     BACKEND (Express/TS)                            

                                                                       
  WebSocket Server (websocket_server.ts)                            
   Topic-based subscriptions                                      
     Each client has topics: Set<string>                        
     Default: ["suggestions"]                                   
     Broadcast filters: if (topic in client.topics) send      
                                                                   
   Broadcast channels (topics):                                  
     "suggestions" ← new suggestions, updates               
     "ticks" ← market ticks (but client never subscribes!) 
     "monitoring" ← monitoring status                       
     "intelligence" ← market intelligence                   
                                                                   
   Tick Broadcaster (tick_feeder.ts)                            
      Receives tick stream from Upstox  WebSocket              
      Queues ticks from ALL subscribed symbols               
      Every 500ms: batches latest tick per symbol            
      broadcast(tickUpdate, "ticks")                         
          But frontend never subscribed to "ticks"!        
                                                                  
  Intraday Monitor (intraday_monitor.ts)                         
   Monitors ~30 stocks from overnightWatchlist                
   Detects entry signals tick-by-tick                        
   Generates suggestions for monitored symbols               
                                                                  
  Market Indices Feed                                            
   /api/market/dashboard-indices (polled every 30s)          
      Returns NIFTY, BANKNIFTY, FINNIFTY, SENSEX, VIX      
                                                                  

```

### ROOT CAUSE #1: Tick Updates Never Reach Frontend

**Evidence:**
- Backend broadcasts: `broadcast(createServerEvent.tickUpdate(...), "ticks")`  [tick_feeder.ts:158]
- Frontend default subscriptions: `tc.topics = new Set(["suggestions"])` [websocket_server.ts:27]
- Frontend never sends subscribe message for "ticks"
- Result: Ticks are broadcasted on "ticks" topic, but no frontend clients are listening

**Impact on UI:**
- Charts would not render live price updates (though candles are fetched via REST API)
- Real-time tick-based analysis in panels is disabled

### ROOT CAUSE #2: No Symbol Filtering

**Evidence:**
- All 92+ symbols can be selected: `selectedSymbol` can be any stock
- Only ~30 are in `overnightWatchlist` and under active monitoring
- ActiveRecommendation lookup: `activeSuggestions.find(s => s.symbol === selectedSymbol)`
- If symbol not in suggestions, activeRecommendation = null → all fields show "--"

**Example:**
```
User selects: "BAJAJFINSV"  (not in watchlist)
↓
activeRecommendation = null  (no data)
↓
AI Outlook Score: "--"  (because !activeRecommendation)
Risk Matrix: "--" (because !activeRecommendation)
Trade Ticket: "--" (because !activeRecommendation)
```

This is correct behavior when no monitoring exists, but the UX doesn't communicate this clearly.

### ROOT CAUSE #3: Indices Polled, Not Streamed

**Evidence:**
- Indices fetched via REST: `useEffect(() => setInterval(() => fetch("/api/market/dashboard-indices"), 30_000))`
- No WebSocket subscription for indices updates
- Polled every 30 seconds (coarse granularity)
- NIFTY/BANKNIFTY might update, but FINNIFTY/VIX may not if Upstox feed doesn't include them

**Impact:**
- Indices data 30s stale
- No real-time updates for market regime changes
- VIX/Breadth depend on external feed reliability

### ROOT CAUSE #4: No Symbol Subscription Protocol

**Current state:**
- Frontend doesn't tell backend "I'm interested in symbol X"
- Backend broadcasts ALL ticks to subscribed clients (wasteful)
- No way to filter by symbol server-side

**Missing protocol:**
```typescript
// Frontend should send something like:
{ event: "subscribe_symbol", data: { symbol: "RELIANCE" } }

// Backend should track per-client:
clientSubscriptions.set(ws, { symbol: "RELIANCE", topics: [...] })

// Tick broadcaster filters:
if (clientSymbol === tickSymbol || clientSymbol === null) {
  broadcast(tick, to client)
}
```

### ROOT CAUSE #5: React Query Cache Issues

**Potential issue (needs verification):**
- `useGetActiveSuggestions()` is keyed by `getGetActiveSuggestionsQueryKey()` (no symbol param)
- All symbols' suggestions are in ONE cache entry
- When suggestion is updated for one symbol, entire cache invalidates
- But which symbol's data appears in the UI depends on `selectedSymbol`

**Risk:**
- If WebSocket handler invalidates wrong cache key after symbol switch, UI would be frozen
- If dependency array is missing in callback, closure captures stale symbol

---

## HOW THE "--" FIELDS WORK (Current)

### AI Outlook / Risk Matrix / Trade Ticket Panels

**Data Source:** `activeRecommendation` (from React Query via `/api/suggestions/active`)

```typescript
// Dashboard.tsx
const activeRecommendation = useMemo(() => {
  return (activeSuggestions ?? []).find((s: Suggestion) => s.symbol === selectedSymbol) || null;
}, [activeSuggestions, selectedSymbol]);

const entry = activeRecommendation?.entryPrice ?? null;
const stop = activeRecommendation?.stopLoss ?? null;
const target = activeRecommendation?.target1 ?? null;

// In UI:
<span>{entry == null ? "--" : fmtNum(entry)}</span>
```

**Why they show "--":**
1. User selects non-monitored symbol
2. `activeSuggestions` doesn't include it (only monitored symbols have suggestions)
3. `activeRecommendation = null`
4. All derived fields (`entry`, `stop`, `target`) → `null` → display "--"

**This is correct behavior**, but the UX should say "Not monitored" instead of silently showing "--".

### Top Bar Indices

**Data Source:** Direct REST API polling

```typescript
useEffect(() => {
  const load = async () => {
    const data = await fetch("/api/market/dashboard-indices");
    setIndices(data);
  };
  load();
  setInterval(load, 30_000);
}, []);

// In UI:
<span>{fmtPct(indices?.finnifty?.changePct)}</span>
// Shows "--" if finnifty missing from response
```

**Why they show "--":**
1. Backend tries to fetch FINNIFTY from Upstox API
2. Upstox may not have it in their quote feed, or it's under a different key
3. Response doesn't include finnifty → indices object missing it
4. UI renders "--"

This likely indicates:
- Upstox API key mismatch for FINNIFTY  
- Upstox account doesn't have permission for all indices
- Backend logic to map Upstox keys to symbols is incomplete

---

## VERIFICATION CHECKLIST

Before implementing fixes, I need to confirm these assumptions:

### For Part 1 (Symbol Locking):
- [ ] Is tick_update being broadcasted at all? (add temporary log in tick_feeder.ts)
- [ ] Is frontend receiving ticks? (add console.log in useWebSocket.ts tick_update handler)
- [ ] Does the client ever subscribe to "ticks" topic? (check if any subscribe message is sent)
- [ ] What symbols are included in tick broadcasts? (log broadcastTicks array)

### For Part 2 (Data Stuck):
- [ ] **AI Outlook/Risk Matrix/Trade Ticket:** Are these stuck because symbol not monitored (expected) or because activeRecommendation isn't updating when it should?
  - Can you select RELIANCE (which IS in watchlist) and confirm those fields populate?
  - Can you select BAJAJFINSV (not in watchlist) and confirm they show "--"?
  
- [ ] **Indices (FINNIFTY/VIX/Breadth):**  
  - What does `/api/market/dashboard-indices` actually return? (screenshot/network tab)
  - Are finnifty, vix, breadth properties present but null, or completely missing?
  - Can you verify FINNIFTY/VIX are in Upstox's instrument universe?

- [ ] **Cache/Dependency Issues:**
  - When you switch selectedSymbol, does the activeRecommendation update instantly or lag?
  - Do you see multiple query cache hits/misses in React Query DevTools?

---

## PROPOSED SOLUTIONS (High Level)

### Part 1: Lock Tick Monitoring to Active Symbol

**Option A: Client-Side Filtering (Minimal)**
1. Frontend subscribes to "ticks" topic on WebSocket connect
2. useWebSocket filters tick_update to only activeSymbol
3. PriceChart and tick-dependent panels only consume filtered ticks
4. Backend tick broadcaster remains unchanged (broadcasts all)

**Pros:** Simple, works immediately
**Cons:** Wastes bandwidth (all ticks sent, then filtered client-side)

**Option B: Server-Side Filtering (Better)**
1. Frontend sends `subscribe_symbol` message with selectedSymbol
2. Backend maintains per-client symbol subscription
3. Tick broadcaster filters: only send ticks for subscribed symbol (or all symbols if subscribed to "*")
4. Frontend auto-resubscribes when selectedSymbol changes

**Pros:** Efficient, proper architecture, extensible
**Cons:** More backend changes

**Recommended:** Option B (proper architecture) with fallback to Option A if time-constrained

---

**Implementation for Part 1:**
```
FRONTEND:
1. In Dashboard.tsx: useEffect(() => { 
     if (selectedSymbol) wsRef?.send(subscribe_symbol msg)
   }, [selectedSymbol])
   
2. In useWebSocket tick handler: filter to activeSymbol only

BACKEND:
1. Add client-to-server event: SubscribeSymbolEvent 
2. In websocket_server.ts: track client symbol subscriptions
3. In tick_feeder.ts: filter broadcastTicks to subscribed symbols
```

---

### Part 2: Fix Stuck Fields

**For AI Outlook/Risk Matrix/Trade Ticket:**
- These are NOT broken — they correctly show "--" for non-monitored symbols
- **Fix:** Add UX message "This symbol is not actively monitored" instead of silent "--"
- **Or:** Automatically select a monitored symbol on page load (e.g. first in watchlist)

**For Indices (FINNIFTY/VIX/Breadth):**
1. Audit `/api/market/dashboard-indices` response format
2. If Upstox doesn't return FINNIFTY, add fallback or skip it
3. Consider switching to WebSocket market feed instead of polling (integrate market_intelligence_update event)

**For React Query Cache:**
- Verify dependency arrays in useMemo calls are correct
- Monitor cache key consistency across symbol switches
- Add React Query DevTools logging to catch stale cache issues

---

## NEXT STEPS

1. **You confirm** which fields are *actually* stuck vs just "not monitored"
2. **You choose:** Do you want Option A (client-side filter) or Option B (server-side)?
Once you review this analysis and provide clarification on the above questions, I'll implement the fixes as separate, reviewable changes.

---

## CONSTRAINTS & UNKNOWNS

This section lists all assumptions made about external systems, APIs, and internal behavior that have NOT been formally verified against official documentation.

### Upstox API Assumptions

#### Rate Limiting & Retry Behavior
- **Assumption:** Upstox returns `Retry-After` header on 429 (Too Many Requests) responses
- **Code Reference:** `lib/upstox-client.ts`
- **Verification Status:**  Code assumes it; not verified against Upstox API docs
- **Impact:** If `Retry-After` is not returned, the retry logic may not wait appropriately

#### Market Data Feed Format
- **Assumption:** Market data WebSocket feed is Protobuf-encoded
- **Code Reference:** `market_data/market_feed.ts`
- **Verification Status:**  Implemented but not validated against live feed
- **Impact:** Decoding errors if format changes

#### Subscription Batch Limits
- **Assumption:** Max 100 subscription keys per single call to Upstox
- **Code Reference:** `market_data/market_feed.ts`
- **Verification Status:**  Hardcoded; not confirmed in official docs
- **Impact:** Batching may be suboptimal or trigger rate limits if limit is higher

#### Token Expiry Handling
- **Assumption:** Upstox access tokens expire exactly at the `expiresIn` duration
- **Code Reference:** `upstox/auth.ts`
- **Verification Status:**  Assumed standard OAuth2; not verified for Upstox specifics
- **Impact:** Could miss expiry or wait too long if Upstox's clock skew differs

#### Error Code Meanings
- **Assumption:** Error code `UDAPI100050` from Upstox indicates invalid/expired token
- **Code Reference:** `upstox/auth.ts`
- **Verification Status:**  Hardcoded based on observation; not in official docs
- **Impact:** May not catch all token-related failures if Upstox changes error codes

---

### Suggestions & Signals Schema

#### Suggestion Status Values
- **Assumption:** Suggestion.status supports values: `ACTIVE`, `TARGET_1_HIT`, `TARGET_2_HIT`, `STOP_HIT`, `EXPIRED`
- **Code Reference:** `db/src/schema/suggestions.ts`
- **Verification Status:**  Documented in schema; defined in enum
- **Impact:** None for now; schema enforces these values

#### Suggestion Validity Window
- **Assumption:** Suggestions become invalid after `validityTill` timestamp
- **Code Reference:** `suggestions/suggestion_manager.ts`
- **Verification Status:**  Implemented explicitly
- **Impact:** None; actively managed

---

### Resilience & Recovery

#### WebSocket Subscription Recovery
- **Assumption:** Intraday monitoring subscriptions survive backend restart via Redis persistence
- **Code Reference:** `analysis/intraday_monitor.ts`
- **Verification Status:**  Implemented; tested with Redis mock
- **Impact:** Subscriptions restore on backend restart

#### Client Active Symbol Recovery
- **Assumption:** Client `activeSymbol` selection recovers automatically on backend restart.
- **Code Reference:** Frontend `useStore` persists to LocalStorage and `useWebSocket` auto-subscribes on reconnect.
- **Verification Status:**  Implemented via Frontend LocalStorage + WebSocket auto-resubscription.
- **Impact:** Users automatically resume viewing their last selected symbol after backend restarts.

---

### Worker Pool & Task Queue

#### Queue Size & Timeout Limits
- **Assumption:** `maxQueueSize = 500` and `taskTimeoutMs = 10000` are appropriate for 15-20 symbols
- **Code Reference:** `intelligence/worker_pool.ts`
- **Verification Status:**  Hardcoded; not validated under realistic load
- **Impact:** Unknown if backpressure/timeouts actually trigger under market hours load
- **Mitigation Needed:** Add load test to confirm

#### Candidate Detection Pool
- **Assumption:** Candidate detection should complete within 10 seconds per symbol
- **Verification Status:**  Not validated; depends on market data availability
- **Impact:** May timeout if candle data retrieval is slow

---

### Authorization & Token Refresh

#### Token Refresh Capability
- **Assumption:** Upstox does NOT support silent token refresh; requires interactive OAuth re-login daily
- **Code Reference:** `upstox/auth.ts`
- **Verification Status:**  Assumed based on implementation; not explicitly confirmed with Upstox
- **Impact:** System cannot run unattended for multiple days without manual token re-authentication
- **Behavior:** On token expiry, users must click "Login" button again to get new token

---

### Recommendations

1. **Verify with Upstox:**
   - Official documentation for `Retry-After` header behavior
   - Error code meanings (especially `UDAPI100050`)
   - Subscription batch size limits
   - Token expiry precision and refresh capabilities

2. **Load Testing (PRIORITY):**
   - Simulate 15-20 simultaneous stock analysis to verify queue backpressure triggers
   - Confirm task timeout doesn't exceed realistic completion times

3. **Client State Recovery (PRIORITY):**
   - Decide: Persist activeSymbol to Redis or leave as manual reselect?
   - Implement chosen behavior

4. **Documentation:**
   - Add inline comments linking assumptions to this file
   - Update API docs to explain token-auth limitation (requires daily manual login)