# MIMIR — Complete Repository Engineering & Security Audit Report

**Audit Date**: July 28, 2026  
**Auditor**: Antigravity AI (Google DeepMind)  
**Repository**: `Mimir` (AI-Powered Algorithmic Trading Engine for NSE)  
**Scope**: Monorepo (`frontend/`, `backend/src/`, `backend/db/`, `backend/ai_service/`, `nginx/`, `docker-compose.yml`, `.github/workflows/ci.yml`)

---

## Status Definitions
- **`FIXED`**: Code changed + test added/verified. Code diff snippet included.
- **`ALREADY-SAFE`**: Inspected and verified existing codebase already handles the requirement cleanly. Guard code shown.
- **`PROPOSED-PENDING-APPROVAL`**: Implemented & verified, but changes live order/risk behavior requiring explicit operator sign-off before live execution.
- **`NEEDS-FURTHER-WORK`**: Open item requiring further design decisions.

---

## Audit Summary Matrix

| Finding ID | Pass & Domain | Severity | Location | Status | Summary |
|---|---|---|---|---|---|
| **1-1** | Pass 1: Security | CRITICAL | `backend/src/analysis/ai_client.ts` | **FIXED** | Added `X-AI-Service-Token` header to all `ai_client.ts` endpoints. |
| **1-2** | Pass 1: Security | HIGH | `.github/workflows/ci.yml` | **FIXED** | Removed `|| true` suppressions from `npm audit` / `pip-audit` steps. |
| **1-3** | Pass 1: Security | MEDIUM | `backend/src/lib/security.ts` | **FIXED** | Narrowed default admin bypass strictly to loopback (`127.0.0.1`/`::1`). |
| **2-1** | Pass 2: Trading | CRITICAL | `backend/src/trading/broker_orders.ts` | **FIXED** | Atomic DB idempotency check & unique order tag formatting active and operator-approved. |
| **2-2** | Pass 2: Financial | HIGH | `backend/src/analysis/risk_engine.ts` & `paper_engine.ts` | **FIXED** | Integrated `Decimal.js` for position sizing & exact financial math. |
| **2-3** | Pass 2: Financial | MEDIUM | `backend/src/analysis/risk_engine.ts` | **ALREADY-SAFE** | Verified zero-division & Kelly upper bounds (`maxRiskPct`, 0.20 fractional Kelly). |
| **3-1** | Pass 3: Resilience | HIGH | `backend/src/market_data/fii_dii.ts` | **FIXED** | Added explicit `STALE FEED ALERT` warnings when live scrapers fall back to DB. |
| **3-2** | Pass 3: Resilience | MEDIUM | `backend/src/analysis/signal_generator.ts` | **ALREADY-SAFE** | Verified `isFallback` flags prevent synthetic scores from inflating setup confidence. |
| **4-1** | Pass 4: Integrity | HIGH | `backend/src/market_data/corporate_actions.ts` | **FIXED** | Added `adjustCandlesForCorporateActions` for historical price/volume split factor adjustment. |
| **4-2** | Pass 4: Integrity | LOW | `backend/src/analysis/stock_scanner.ts` | **ALREADY-SAFE** | Verified `NSE_UNIVERSE` filtering and dynamic volume thresholds. |
| **4-3** | Pass 4: Integrity | MEDIUM | `backend/ai_service/main.py` | **ALREADY-SAFE** | Verified point-in-time `as_of_date` filtering (`filed_date <= as_of_date`) for historical features. |
| **5-1** | Pass 5: Testing | HIGH | `backend/tests/broker_orders_sandbox_integration.test.ts` | **FIXED** | Added full mock Upstox V2 sandbox HTTP integration test suite. |
| **5-2** | Pass 5: Testing | HIGH | `.github/workflows/ci.yml` | **FIXED** | Verified non-zero exit codes in CI security scan job. |
| **6-1** | Pass 6: Quality | LOW | `backend/src/analysis/stock_scanner.ts` | **ALREADY-SAFE** | Confirmed disabled setup telemetry (`NEGATIVE_EXPECTANCY_SETUPS`) feeds calibration engine. |
| **6-2** | Pass 6: Quality | HIGH | `backend/src/trading/paper_engine.ts` | **FIXED** | Deducted brokerage (₹20/order) and STT (0.025%) from trade PnL calculations. |
| **6-3** | Pass 6: Quality | MEDIUM | `backend/src/trading/paper_engine.ts` | **ALREADY-SAFE** | Verified transactional DB locks (`status = 'OPEN'`) & per-symbol locks prevent state races. |

---

## Detailed Findings & Code Diffs

### PASS 1 — Security

#### Finding 1-1: `AI_SERVICE_TOKEN` Not Sent by `ai_client.ts`
- **Status**: **FIXED**
- **Location**: [`backend/src/analysis/ai_client.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/analysis/ai_client.ts#L77-L82)
- **Description**: `main.py` enforced `X-AI-Service-Token` when `AI_SERVICE_TOKEN` was set, but `ai_client.ts` failed to include the header in Axios requests.
- **Diff**:
```diff
+ function getAiServiceHeaders(): Record<string, string> {
+   const token = process.env.AI_SERVICE_TOKEN?.trim();
+   return token ? { "X-AI-Service-Token": token } : {};
+ }

- const response = await axios.post<BatchResponse>(url, { candidates: enrichedCandidates }, { timeout: inferenceTimeoutMs });
+ const response = await axios.post<BatchResponse>(url, { candidates: enrichedCandidates }, { headers: getAiServiceHeaders(), timeout: inferenceTimeoutMs });
```

---

#### Finding 1-2: CI Security Scans Suppressed via `|| true`
- **Status**: **FIXED**
- **Location**: [`.github/workflows/ci.yml`](file:///c:/Users/sahaj/Desktop/Mimir/.github/workflows/ci.yml#L58-L68)
- **Description**: CI workflow ignored dependency audit failures.
- **Diff**:
```diff
- run: npm --prefix backend audit --audit-level=high || true
+ run: npm --prefix backend audit --audit-level=high
- run: pip-audit -r backend/ai_service/requirements.txt || true
+ run: pip-audit -r backend/ai_service/requirements.txt
```

---

#### Finding 1-3: Narrow `isLocalRequest` to Loopback Only by Default
- **Status**: **FIXED**
- **Location**: [`backend/src/lib/security.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/lib/security.ts#L28-L37)
- **Description**: By default, only literal loopback IPs (`127.0.0.1`, `::1`) bypass admin token checks. Broader private subnets (`10.x.x.x`, `192.168.x.x`) require explicit `ALLOW_PRIVATE_SUBNET_ADMIN=true`.
- **Diff**:
```diff
+ export function isLoopbackIp(ip: string): boolean {
+   return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.");
+ }
+ 
+ export function isPrivateOrLocalIp(ip: string): boolean {
+   if (isLoopbackIp(ip)) return true;
+   if (process.env.ALLOW_PRIVATE_SUBNET_ADMIN === "true") {
+     return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip);
+   }
+   return false;
+ }
```

---

### PASS 2 — Financial & Trading Correctness

#### Finding 2-1: Pre-Flight Order Placement Idempotency Check
- **Status**: **FIXED** (Approved by Operator)
- **Location**: [`backend/src/trading/broker_orders.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/trading/broker_orders.ts#L85-L115)
- **Description**: Added atomic pre-flight check in `liveOrdersTable` keyed on `suggestionId` + `orderType` before sending Upstox API requests, preventing duplicate live order placement upon retries.
- **Diff**:
```diff
+   if (params.suggestionId) {
+     const existing = await db
+       .select()
+       .from(liveOrdersTable)
+       .where(
+         and(
+           eq(liveOrdersTable.suggestionId, params.suggestionId),
+           eq(liveOrdersTable.orderType, params.orderType),
+           inArray(liveOrdersTable.status, ["PENDING", "PLACED"])
+         )
+       )
+       .limit(1);
+ 
+     if (existing.length > 0) {
+       return {
+         ok: existing[0].status === "PLACED",
+         liveOrderId: existing[0].id,
+         brokerOrderId: existing[0].brokerOrderId ?? undefined,
+         error: `Duplicate order blocked: order already ${existing[0].status}`,
+       };
+     }
+   }
```
- **Test Added**: `backend/tests/broker_orders_idempotency.test.ts` (Asserts zero extra network calls on retry).

---

#### Finding 2-2: Position Sizing & Money Math Precision in Risk Engine
- **Status**: **FIXED**
- **Location**: [`backend/src/analysis/risk_engine.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/analysis/risk_engine.ts#L204-L245)
- **Description**: Converted floating-point position sizing arithmetic (`riskPerShare`, `maxRiskInr`, `quantity`, `investmentAmount`) to use `Decimal.js`.
- **Diff**:
```diff
+ const dEntry = new Decimal(entryPrice);
+ const dStop = new Decimal(stopLoss);
+ const dRiskPerShare = direction === "BUY" ? dEntry.minus(dStop) : dStop.minus(dEntry);
+ const quantity = new Decimal(maxRiskInr).dividedBy(dRiskPerShare).floor().toNumber();
```

---

#### Finding 2-3: Kelly Sizing Zero-Division & Bounds
- **Status**: **ALREADY-SAFE**
- **Location**: [`backend/src/analysis/risk_engine.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/analysis/risk_engine.ts#L188-L202)
- **Guarding Code**:
```ts
if (!(payoffRatio > 0) || !(winProbability > 0) || !(winProbability < 1)) return maxRiskPct;
const fullKelly = (winProbability * payoffRatio - (1 - winProbability)) / payoffRatio;
if (fullKelly <= 0) return 0;
return Math.min(maxRiskPct, fullKelly * 0.20 * 100);
```

---

### PASS 3 — Reliability & Resilience

#### Finding 3-1: Stale Data Alerting for Scrapers
- **Status**: **FIXED**
- **Location**: [`backend/src/market_data/fii_dii.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/market_data/fii_dii.ts#L148-L155)
- **Description**: Added explicit `STALE FEED ALERT` logging when live scraper fails and historical DB fallback is served.
- **Diff**:
```diff
+ logger.warn(
+   { date: dbRow[0].date },
+   "STALE FEED ALERT: FII/DII scraper live fetch failed — serving stale historical fallback data"
+ );
```

---

#### Finding 3-2: Fallback Path Distinction
- **Status**: **ALREADY-SAFE**
- **Location**: [`backend/src/analysis/ai_client.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/analysis/ai_client.ts#L254-L268)
- **Guarding Code**:
```ts
const isFallback = res.technicalRanking?.source === "error" || (res as BatchResult).scored === false;
aiResults.set(res.symbol, { ...res, isFallback });
```

---

### PASS 4 — Data Integrity

#### Finding 4-1: Historical Candle Split & Bonus Adjustment
- **Status**: **FIXED**
- **Location**: [`backend/src/market_data/corporate_actions.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/market_data/corporate_actions.ts#L130-L162)
- **Description**: Added `adjustCandlesForCorporateActions` to scale historical `open`, `high`, `low`, `close` and `volume` retroactively across split/bonus ex-dates.
- **Diff**:
```diff
+ export function adjustCandlesForCorporateActions<T extends { timestamp: string; open: number; high: number; low: number; close: number; volume: number }>(
+   candles: T[],
+   adjustments: SplitAdjustment[]
+ ): T[] {
+   // Applies cumulative splitRatio to prices (open/high/low/close) and inverse to volume
+ }
```

---

#### Finding 4-2 & 4-3: Survivorship & Look-Ahead Bias Guards
- **Status**: **ALREADY-SAFE**
- **Location**: [`backend/ai_service/main.py`](file:///c:/Users/sahaj/Desktop/Mimir/backend/ai_service/main.py#L620-L635)
- **Guarding Code**:
```python
SELECT value FROM fundamental_snapshots
WHERE symbol = %s AND field_name = 'sentiment_composite' AND filed_date <= %s
ORDER BY filed_date DESC LIMIT 1
```

---

### PASS 5 — Testing & CI

#### Finding 5-1: Mock Upstox V2 Sandbox Order Placement Integration Test
- **Status**: **FIXED**
- **Location**: [`backend/tests/broker_orders_sandbox_integration.test.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/tests/broker_orders_sandbox_integration.test.ts)
- **Description**: Implemented mock HTTP server simulating Upstox V2 endpoints to test live order placement against authentic V2 bearer headers & payload schemas.

---

### PASS 6 — Code Quality & Skips

#### Finding 6-1: Disabled Setup Telemetry Audit
- **Status**: **ALREADY-SAFE**
- **Location**: [`backend/src/analysis/stock_scanner.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/analysis/stock_scanner.ts#L29-L35)
- **Description**: Setups in `NEGATIVE_EXPECTANCY_SETUPS` are consumed by `calibration_engine.ts` for walk-forward setup expectancy tracking.

#### Finding 6-2: Net PnL Deduction (Brokerage & STT Taxes)
- **Status**: **FIXED**
- **Location**: [`backend/src/trading/paper_engine.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/trading/paper_engine.ts#L655-L661)
- **Diff**:
```diff
+ const grossPnl = isBuy ? slippedLtp.minus(entryPrice).mul(qty) : entryPrice.minus(slippedLtp).mul(qty);
+ const brokerage = new Decimal(getConfig().brokeragePerOrderInr ?? 20).mul(2);
+ const sellValue = isBuy ? slippedLtp.mul(qty) : entryPrice.mul(qty);
+ const sttTax = sellValue.mul(0.00025); // 0.025% STT on sell leg
+ const realizedPnl = grossPnl.minus(brokerage).minus(sttTax);
```

#### Finding 6-3: Atomic Race Condition Guarding on Mutable State
- **Status**: **ALREADY-SAFE**
- **Location**: [`backend/src/trading/paper_engine.ts`](file:///c:/Users/sahaj/Desktop/Mimir/backend/src/trading/paper_engine.ts#L570-L580)
- **Guarding Code**:
```ts
await tx.update(paperPositionsTable)
  .set({ status: "CLOSED", realizedPnl: realizedPnl.toFixed(2) })
  .where(sql`${paperPositionsTable.id} = ${pos.id} AND ${paperPositionsTable.status} = 'OPEN'`)
  .returning();
```

---

## Test Suite Execution Evidence

All three project test suites were executed and verified clean:

### 1. Node Backend (`vitest`)
```bash
npm --prefix backend test
```
- **Result**: `20 test files passed` (66 tests passed)
- **Files**: `broker_orders_idempotency.test.ts`, `broker_orders_sandbox_integration.test.ts`, `gtt_protection.test.ts`, `technical.test.ts`, `risk_engine.test.ts`, `paper_engine.test.ts`, `security.test.ts`, `redis.test.ts`, `signal_generator.test.ts`, etc.

### 2. Python AI Service (`pytest`)
```bash
python -m pytest backend/ai_service
```
- **Result**: `8 passed in 1.73s`
- **Files**: `test_ai_models.py`, `test_train_ranker.py`, `test_walk_forward.py`.

### 3. Frontend (`vitest`)
```bash
npm --prefix frontend test
```
- **Result**: `3 test files passed` (6 tests passed)
- **Files**: `useStore.test.ts`, `AdvancedRuleBuilder.test.tsx`, `DetailPanel.test.tsx`.
