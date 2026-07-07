# Part 2 Audit: Stuck Field Analysis & Logging Guide

## OVERVIEW

This document explains the comprehensive logging added to trace why fields show "--" and identify whether it's due to legitimate "not monitored" states or actual bugs.

---

## WHAT WAS ADDED

### Frontend Logging (Dashboard.tsx)

**Location:** Dashboard component, after activeRecommendation computation

Two new useEffect hooks log:

1. **activeRecommendation data flow** → Logged to console group `[AUDIT] activeRecommendation for {symbol}`
   - selectedSymbol
   - Total count of activeSuggestions
   - All symbols in activeSuggestions (which ones are monitored)
   - Whether activeRecommendation was found
   - If found: direction, entryPrice, stopLoss, target1, riskReward, quantity, signalFactors
   - If NOT found: Warning "⚠️ No recommendation found - symbol may not be monitored"

2. **Indices data flow** → Logged to console group `[AUDIT] Indices data`
   - Raw indices object (all properties)
   - Individual values for: nifty, banknifty, finnifty, sensex, vix, breadth
   - Any error messages from indices fetch

**When to check:** Open DevTools Console (F12), select Dashboard page, look for `[AUDIT]` prefixed messages when:
- Changing selectedSymbol
- Fields show "--" unexpectedly
- Indices are missing

**How to read:**
```
[AUDIT] activeRecommendation for RELIANCE
  ← This means looking up RELIANCE
  selectedSymbol: "RELIANCE"
  activeSuggestions count: 3
  activeSuggestions symbols: ["RELIANCE", "TCS", "INFY"]
  ← We have 3 active suggestions
  activeRecommendation found: true
  ← RELIANCE is one of them
  - direction: "BUY"
  - entryPrice: 2850.50
  - ... (all fields populated)

[AUDIT] Indices data
  indices: { nifty50: {...}, sensex: {...}, bankNifty: {...}, finnifty: null, vix: null, ... }
  ← FINNIFTY is null - this is the problem!
  - finnifty: null
  - vix: null
  indicesError: ""
```

### Frontend WebSocket Event Logging (useWebSocket.ts)

**Locations:** useWebSocket hook event handlers

Added console.log statements for key events:

1. **new_suggestion** → `[AUDIT] Received new_suggestion event: {data}`
2. **suggestion_updated** → `[AUDIT] Received suggestion_updated event: {data}`
3. **market_regime_changed** → `[AUDIT] Received market_regime_changed event: {data}`

**When to check:** Monitor the console while:
- Scanner generates new suggestions
- Signals change status
- Market regime switches

### Backend Logging

#### 1. Active Suggestions Query (suggestions.ts)

**Endpoint:** `GET /api/suggestions/active`

Logs to **backend console**:
```
[AUDIT] /api/suggestions/active: Found X active suggestions
[AUDIT] Symbols with active suggestions: RELIANCE, TCS, INFY, ...
[AUDIT] First suggestion: { symbol, direction, entryPrice, stopLoss, target1, riskReward, status, generatedAt }
[AUDIT] /api/suggestions/active: Returning X serialized suggestions
```

**When to check:** 
- Run in terminal: `npm run dev` or look at server logs
- When dashboard feels stuck or no data appears

#### 2. Indices Data Build (market.ts - buildDashboardIndices)

**Function:** `buildDashboardIndices()`

Logs to **backend console**:
```
[AUDIT] buildDashboardIndices: Fetching indices for keys: [...]
[AUDIT] buildDashboardIndices: priceByKey result: { ... }
[AUDIT] buildDashboardIndices: Found valid price for NIFTY_50: 25000.50
[AUDIT] buildDashboardIndices: No valid price found in candidates: [...]
[AUDIT] buildDashboardIndices: Selected indices: { nifty50, sensex, bankNifty, finnifty, indiaVix }
[AUDIT] buildDashboardIndices: Final result: { nifty50: {...}, sensex: {...}, finnifty: null, ... }
```

**When to check:**
- Monitor backend logs (npm run dev)
- When indices show "--"
- To diagnose Upstox API key issues (invalid tokens, missing permissions)

#### 3. New Suggestion Broadcasting (intraday_monitor.ts)

**Location:** When suggestion is generated and broadcast

Logs to **backend console**:
```
[AUDIT] Broadcasting newSuggestion for RELIANCE - direction: BUY entry: 2850.50
```

**When to check:**
- During market hours when signals generate
- To confirm backend is detecting entry conditions

---

## ROOT CAUSE ANALYSIS: STUCK FIELDS

### **AI Outlook / Risk Matrix / Trade Ticket (Entry/Stop/Target/RR/Qty)**

**Question:** Do these show "--" for ALL symbols or just some?

#### Case 1: Show "--" for RELIANCE (which IS monitored)
**Root Cause:** activeRecommendation = null even though symbol should be in suggestions
**Indicators:**
- Frontend log: `activeRecommendation found: false` for RELIANCE
- Backend log: RELIANCE not in `activeSuggestions symbols` list
- Possible causes:
  - Scanner hasn't run yet today
  - Database query failed (check backend errors)
  - Suggestion status is not "ACTIVE" (might be "CLOSED" or "EXPIRED")
  - WebSocket event not being received (check new_suggestion logs)

**Fix:** Check backend /api/suggestions/active response; confirm RELIANCE exists with status="ACTIVE"

#### Case 2: Show "--" for BAJAJFINSV (NOT in watchlist)
**Root Cause:** This is CORRECT behavior - symbol is not being monitored
**Indicators:**
- Frontend log: `activeRecommendation found: false`
- Backend log: BAJAJFINSV not in `activeSuggestions symbols` list (only has ~30 monitored symbols)
- Frontend log: `⚠️ No recommendation found - symbol may not be monitored`

**Fix:** This is NOT a bug. Add UX text: "Not actively monitored" instead of showing "--"

### **Indices (NIFTY / BANKNIFTY / FINNIFTY / SENSEX / VIX / Breadth)**

**Question:** Which indices show "--"?

#### Case 1: FINNIFTY and VIX show "--"
**Root Cause:** Upstox API doesn't return these in the feed, OR wrong instrument key is being used
**Indicators:**
- Frontend log: `finnifty: null`, `vix: null`
- Backend log: `No valid price found in candidates: [...]` for FINNIFTY
- Backend log: `priceByKey result: {}` — empty response from Upstox

**Diagnosis steps:**
1. Check backend console for which keys were tried (OUTPUT from pickAvailable)
2. Verify INDEX_KEY_CANDIDATES contains correct Upstox instrument keys
3. Check Upstox API permissions — account may not have access to all indices

**Possible fixes:**
- Add fallback handling: skip FINNIFTY, don't crash
- Use different Upstox instrument keys (check Upstox docs)
- Fallback to hardcoded last known value
- Remove FINNIFTY from dashboard if Upstox doesn't support it

#### Case 2: NIFTY/BANKNIFTY/SENSEX show "--" but indices are actually available
**Root Cause:** Timing issue — fetch failed, or wrong data structure in response
**Indicators:**
- Backend log: priceByKey has no keys matching NIFTY candidates
- Frontend error: `indicesError: "..."`

**Fix:** Check backend error logs, retry logic, Upstox connectivity

#### Case 3: Breadth shows "--"
**Root Cause:** Breadth is computed from market overview (advanceCount/declineCount), not from indices feed
**Indicator:**
- In Dashboard.tsx: `const breadth = adv + decline > 0 ? ... : null;`
- Depends on `overview` data from useGetMarketOverview

**Fix:** Check if market overview query is returning data; different data source than indices

---

## STEP-BY-STEP DEBUGGING GUIDE

### For "Why is AI Outlook showing '--'?"

1. **Open DevTools Console** (F12)
2. **Select the symbol** that shows "--"
3. **Look for:**
   ```
   [AUDIT] activeRecommendation for YOURSELECTEDSYMBOL
     activeRecommendation found: false
   ```
4. **Then check backend logs** (npm run dev terminal)
   ```
   [AUDIT] /api/suggestions/active: Found X active suggestions
   [AUDIT] Symbols with active suggestions: ...
   ```
5. **Is your symbol in the list?**
   - NO → Symbol is not being monitored (expected behavior)
   - YES → Symbol should have data; check DB query or WebSocket events

### For "Why is FINNIFTY showing '--'?"

1. **Open DevTools Console** (F12)
2. **Look for:**
   ```
   [AUDIT] Indices data
     indices: { finnifty: null }
   ```
3. **Check backend logs** for:
   ```
   [AUDIT] buildDashboardIndices: No valid price found in candidates: [...]
   [AUDIT] buildDashboardIndices: priceByKey result: { ... }
   ```
4. **Is `priceByKey` empty or missing FINNIFTY keys?**
   - Empty → Upstox API returned no data (auth/permission issue)
   - Present but no match → Wrong instrument key being used

### For "Why is data stuck even after selecting a monitored symbol?"

1. **Clear the browser cache** (hard refresh: Ctrl+Shift+R)
2. **Wait for polling interval** (activeSuggestions refresh every 10s)
3. **Check frontend logs:**
   - Are new_suggestion events being received?
   - Is activeRecommendation updating?
   - Are queries being invalidated?
4. **Check backend logs:**
   - Is /api/suggestions/active returning the symbol?
   - Any errors in the response?

---

## KEY FILES MODIFIED

| File | Change | Purpose |
|------|--------|---------|
| `frontend/src/pages/Dashboard.tsx` | Added 2 useEffect hooks with audit logs | Track activeRecommendation and indices data flow |
| `frontend/src/hooks/useWebSocket.ts` | Added console.log to event handlers | Track when WebSocket events are received |
| `backend/src/routes/suggestions.ts` | Added audit logs to /api/suggestions/active | See which symbols have active suggestions |
| `backend/src/routes/market.ts` | Added audit logs to buildDashboardIndices | Debug why indices fail |
| `backend/src/analysis/intraday_monitor.ts` | Added audit log before broadcast | Confirm new_suggestion events are sent |

---

## NEXT STEPS AFTER AUDIT

Once you review the logs and identify which fields are stuck, we can propose specific fixes:

### If AI Outlook is stuck because symbol not monitored:
✅ **Fix:** Add UX text "This symbol is not actively monitored" or auto-select first monitored symbol

### If indices are stuck because Upstox doesn't support them:
✅ **Fix:** Add fallback rendering ("Data unavailable") or skip those indices

### If data should be there but isn't:
✅ **Fix:** Trace the specific failure point (DB query, WebSocket broadcast, React Query cache, etc.) and implement targeted fix

---

## HOW TO TURN OFF LOGGING (Production)

Once debugging is complete, remove `console.log` statements or wrap them in:
```typescript
if (process.env.DEBUG_AUDIT === 'true') {
  console.log("[AUDIT] ...");
}
```

Or use a debug flag in Zustand store.
