<div style="font-family: 'Geist Mono', monospace;">

# UpstoxBot Backend: Assumptions & Unknowns

This document lists all assumptions made about external systems, APIs, and internal behavior that have NOT been formally verified against official documentation.

## Upstox API Assumptions

### Rate Limiting & Retry Behavior
- **Assumption:** Upstox returns `Retry-After` header on 429 (Too Many Requests) responses
- **Code Reference:** [lib/upstox-client.ts#L105-108](../src/lib/upstox-client.ts#L105-108)
- **Verification Status:**  Code assumes it; not verified against Upstox API docs
- **Impact:** If `Retry-After` is not returned, the retry logic may not wait appropriately

### Market Data Feed Format
- **Assumption:** Market data WebSocket feed is Protobuf-encoded
- **Code Reference:** [market_data/market_feed.ts](../src/market_data/market_feed.ts)
- **Verification Status:**  Implemented but not validated against live feed
- **Impact:** Decoding errors if format changes

### Subscription Batch Limits
- **Assumption:** Max 100 subscription keys per single call to Upstox
- **Code Reference:** [market_data/market_feed.ts#L120](../src/market_data/market_feed.ts#L120)
- **Verification Status:**  Hardcoded; not confirmed in official docs
- **Impact:** Batching may be suboptimal or trigger rate limits if limit is higher

### Token Expiry Handling
- **Assumption:** Upstox access tokens expire exactly at the `expiresIn` duration
- **Code Reference:** [upstox/auth.ts#L84-90](../src/upstox/auth.ts#L84-90)
- **Verification Status:**  Assumed standard OAuth2; not verified for Upstox specifics
- **Impact:** Could miss expiry or wait too long if Upstox's clock skew differs

### Error Code Meanings
- **Assumption:** Error code `UDAPI100050` from Upstox indicates invalid/expired token
- **Code Reference:** [upstox/auth.ts#L150](../src/upstox/auth.ts#L150)
- **Verification Status:**  Hardcoded based on observation; not in official docs
- **Impact:** May not catch all token-related failures if Upstox changes error codes

---

## Suggestions & Signals Schema

### Suggestion Status Values
- **Assumption:** Suggestion.status supports values: `ACTIVE`, `TARGET_1_HIT`, `TARGET_2_HIT`, `STOP_HIT`, `EXPIRED`
- **Code Reference:** [db/src/schema/suggestions.ts#L44](../db/src/schema/suggestions.ts#L44)
- **Verification Status:**  Documented in schema; defined in enum
- **Impact:** None for now; schema enforces these values

### Suggestion Validity Window
- **Assumption:** Suggestions become invalid after `validityTill` timestamp
- **Code Reference:** [suggestions/suggestion_manager.ts#L180](../src/suggestions/suggestion_manager.ts#L180)
- **Verification Status:**  Implemented explicitly
- **Impact:** None; actively managed

---

## Resilience & Recovery

### WebSocket Subscription Recovery
- **Assumption:** Intraday monitoring subscriptions survive backend restart via Redis persistence
- **Code Reference:** [analysis/intraday_monitor.ts#L175-180](../src/analysis/intraday_monitor.ts#L175-180)
- **Verification Status:**  Implemented; tested with Redis mock
- **Impact:** Subscriptions restore on backend restart

### Client Active Symbol Recovery
- **Assumption:** Client `activeSymbol` selection recovers automatically on backend restart.
- **Code Reference:** Frontend `useStore` persists to LocalStorage and `useWebSocket` auto-subscribes on reconnect.
- **Verification Status:**  Implemented via Frontend LocalStorage + WebSocket auto-resubscription.
- **Impact:** Users automatically resume viewing their last selected symbol after backend restarts.

---

## Worker Pool & Task Queue

### Queue Size & Timeout Limits
- **Assumption:** `maxQueueSize = 500` and `taskTimeoutMs = 10000` are appropriate for 15-20 symbols
- **Code Reference:** [intelligence/worker_pool.ts#L54-55](../src/intelligence/worker_pool.ts#L54-55)
- **Verification Status:**  Hardcoded; not validated under realistic load
- **Impact:** Unknown if backpressure/timeouts actually trigger under market hours load
- **Mitigation Needed:** Add load test to confirm

### Candidate Detection Pool
- **Assumption:** Candidate detection should complete within 10 seconds per symbol
- **Verification Status:**  Not validated; depends on market data availability
- **Impact:** May timeout if candle data retrieval is slow

---

## Authorization & Token Refresh

### Token Refresh Capability
- **Assumption:** Upstox does NOT support silent token refresh; requires interactive OAuth re-login daily
- **Code Reference:** [upstox/auth.ts#L84-90](../src/upstox/auth.ts#L84-90)
- **Verification Status:**  Assumed based on implementation; not explicitly confirmed with Upstox
- **Impact:** System cannot run unattended for multiple days without manual token re-authentication
- **Behavior:** On token expiry, users must click "Login" button again to get new token

---

## Recommendations

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

---

**Last Updated:** 2026-06-21
**Status:** 3 HIGH assumptions unverified; 2 tasks need implementation


</div>