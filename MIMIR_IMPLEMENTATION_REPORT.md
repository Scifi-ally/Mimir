# Mimir Trading Signal System — Implementation and Verification Report

**Author:** Manus AI
**Repository:** `Scifi-ally/Mimir`
**Verification date:** 17 August 2026
**Product boundary:** Signal generation and paper trading only; live broker order execution is permanently disabled.

## Executive conclusion

The inherited audit and implementation pass has been completed and re-verified. Mimir now uses one shared trade-economics implementation for sizing and net P&L, applies India-specific market-state quality and tradeability gates, rejects stale signal objects before paper-trading ingestion, reports realized expectancy and drawdown by setup/regime/direction, and enforces paper-only behavior at the broker, configuration, HTTP, frontend, and WebSocket layers.

The final working tree passed the requested build, type-check, lint, test, and whitespace checks. The backend ran successfully on port 5000, the frontend ran successfully on port 3000, and the exposed dashboard loaded in the browser. The runtime environment was intentionally unauthenticated to Upstox during verification; the UI correctly degraded to `OFFLINE / STANDBY awaiting market data` and displayed `PAPER ONLY` rather than fabricating quotes.

> This is a research and paper-trading implementation. It does not prove that Mimir has a profitable or durable market edge, and it must not be used as personalized financial advice.

## Major changes implemented

| Area | Implementation | Verification status |
|---|---|---|
| Trade economics | Added shared `backend/src/trading/trade_economics.ts` for safe quantity sizing, brokerage/STT/fees/slippage-aware net P&L, and zero-quantity rejection. Paper engine, risk engine, accuracy tracker, and outcome verifier use the shared calculation. | Covered by economics and regression tests; included in 24-file backend suite. |
| Paper-only boundary | Broker placement and cancellation are hard-disabled; paper engine no longer mirrors entries or exits to a broker; configuration always resolves to `paperTradingEnabled: true` and `tradingMode: PAPER`. | Boundary tests pass. Legacy trading routes now return a stable PAPER status and HTTP 410 for all live mode/live-account endpoints. |
| Frontend safety | Removed live-mode polling, live broker funds/positions/orders queries, live arming controls, live WebSocket notifications, and destructive LIVE badges. Settings, StatusBar, TopBar, and PaperTradingPanel now describe the system as signal-only paper trading. | Browser verification showed `PAPER ONLY` and `PAPER-ONLY SIGNAL ENGINE`; no live controls were visible. |
| India market state | Added provenance-aware India context with `FULL`, `PARTIAL`, and `UNAVAILABLE` quality states; liquidity/tradeability gates; direction-aware breadth, sector, and institutional-flow adjustments; integration into feature engineering, risk, and scanning. | Five India-market-state tests pass; degraded data is represented as unavailable rather than fabricated. |
| Freshness | Added `backend/src/suggestions/signal_freshness.ts`. Defaults are five minutes for intraday signals and sixty minutes for swing signals. Environment overrides are bounded through `MIMIR_MAX_INTRADAY_SIGNAL_AGE_MINUTES` and `MIMIR_MAX_SWING_SIGNAL_AGE_MINUTES`. Missing or invalid timestamps are rejected. Realtime opportunities are stamped when constructed. | Four freshness regression tests pass. Rejection reasons are classified as execution guards. |
| Expectancy reporting | Existing `/api/reports/expectancy?days=60` was completed and enriched with average realized net P&L per trade and path-dependent maximum drawdown, in addition to win rate, profit factor, total net P&L, R expectancy, and setup/regime/direction buckets. | Endpoint returned HTTP 200 in runtime verification; report code is included in the final backend build and test run. |
| Upstox quota safety | Reworked the process-wide limiter to enforce rolling budgets of 45 requests/second, 450/minute, and 1,800/30 minutes, leaving safety headroom below Upstox’s documented 50/500/2,000 market-data limits. Existing batching, cache TTL separation, canonical LTP keys, retries, and deduplication remain active. | Backend build, lint, and tests pass. The implementation deliberately budgets globally across API versions. |
| Runtime reliability | Fixed both Yahoo Finance v3 call sites that were using an uninitialized default client: `market_feed.ts` and `tick_feeder.ts` now instantiate `YahooFinance`. One-time survey notices are suppressed. | After restart, the constructor failure no longer recurred in the active process; health endpoint returned `status: ok`. Remote free-data 403/401/404 responses still degrade to unavailable state as designed. |
| Code quality | Added frontend and backend lint scripts, frontend TypeScript check script, strict null handling for unavailable realtime scores/features, corrected fill-time duration calculations, and removed fabricated 50-point baselines. | Lint, type-check, build, tests, and `git diff --check` all passed. |

## Validation evidence

The final validation log is saved as `final_validation.log`. The executed matrix produced the following results.

| Check | Result |
|---|---:|
| Root build | Passed |
| Backend typecheck | Passed |
| Backend build | Passed |
| Backend lint | Passed |
| Backend tests | **24 test files, 80 tests passed** |
| Frontend TypeScript check | Passed |
| Frontend build | Passed |
| Frontend lint | Passed |
| Frontend tests | **3 test files, 6 tests passed** |
| `git diff --check` | Passed |
| Isolated clean `npm ci --ignore-scripts` | Passed; 1,025 packages installed |
| Production dependency audit in clean copy | 6 advisories: 2 moderate, 4 high; remediation remains outstanding |

The test suite emits some intentional safety-boundary warnings when it verifies that broker placement/cancellation is refused. Those warnings are expected and do not represent failed tests.

## Runtime verification

The local services were running with PostgreSQL on `5432`, Redis on `6379`, backend on `5000`, and frontend on `3000`. The browser-exposed URL remained:

<https://3000-ir36bvkpxl4sjnpcxvb70-71fd6690.us4.manus.computer/>

The following live checks were performed:

| Check | Observed result |
|---|---|
| `GET /health` | `status: ok` |
| `GET /api/trading/mode` | `mode: PAPER`, `liveActive: false`, `paperOnly: true` |
| `GET /api/trading/live/orders` | HTTP 410, permanent paper-only error |
| `GET /api/reports/expectancy?days=7` | HTTP 200 |
| Browser dashboard | Loaded successfully; showed `PAPER ONLY`, `OFFLINE / STANDBY awaiting market data`, and `INDIAN CONTEXT` unavailable values rather than invented values |
| Settings dialog | Showed `PAPER-ONLY SIGNAL ENGINE`; live arming controls were absent |

Because no real Upstox token was supplied in the verification environment, the application correctly showed read-only authorization prompts and unavailable market values. NSE and other free public endpoints can return 403/404 responses, and Upstox WebSocket connections correctly report 401 when no data token is configured. These cases are degraded-data conditions, not reasons to fabricate signal inputs.

## Evidence and design rationale

Upstox documents the standard market-data API limits as **50 requests per second, 500 per minute, and 2,000 per 30 minutes**, and warns that exceeding limits can cause temporary access suspension [1]. Mimir’s rolling limiter therefore uses 45/450/1,800 process-wide budgets, while caching and request deduplication reduce demand before it reaches the limiter.

SEBI’s July 7, 2025 comparative study provides the primary regulatory and market-structure reference for India’s equity-derivatives context [2]. The implementation treats derivatives activity, liquidity, expiry state, and institutional participation as dated, quality-graded context rather than unconditional directional signals.

AQR’s transaction-cost framework states that transaction costs are necessary to implement investment strategies and that oversimplified cost analysis can produce erroneous conclusions [3]. This supports Mimir’s unified net P&L calculation, paper fills with slippage and statutory costs, and expectancy reporting after costs rather than gross price movement.

## Remaining limitations and next research priorities

The system is now materially safer and more internally consistent, but **accuracy and profitability remain unproven**. The repository does not yet contain a sufficiently large, leakage-resistant, out-of-sample live-like evaluation covering multiple Indian market regimes. The expectancy report explicitly returns insufficient-data verdicts until sample sizes are meaningful; the recommended operating posture is to collect paper outcomes before trusting setup-level filters.

The free-data environment is inherently incomplete and occasionally unavailable. FII/DII, NSE delivery, options, macro, and Yahoo-derived fields may be `PARTIAL` or `UNAVAILABLE`; the system now preserves that provenance and applies hard gates only where evidence is adequate. A production deployment should add persistent, timestamped data-quality telemetry and monitor the proportion of signals rejected for stale or unavailable inputs.

The clean dependency installation succeeded, but its production dependency audit reported six advisories. These should be triaged in a separate dependency-maintenance change rather than applying an unreviewed force-upgrade to a trading research system.

The current rolling limiter is process-wide. If multiple Mimir replicas share the same Upstox identity, the budget must be coordinated across replicas or the per-process budgets must be reduced further. The current deployment is single-process for the verified local stack.

The dashboard is intentionally paper-only, but legacy backend compatibility routes remain as explicit HTTP 410 responses so stale clients fail closed. They should be removed entirely in a future breaking API version after all external clients have migrated.

## Files and artifacts

The principal implementation files are in the working tree. Supporting evidence is available in `MIMIR_SIGNAL_AUDIT.md`, `INDIA_SIGNAL_RESEARCH.md`, `FRESH_RESEARCH_NOTES.md`, `final_validation.log`, `clean_install.log`, and `runtime_probe.log`.

## References

[1]: https://upstox.com/developer/api-documentation/rate-limiting/ "Upstox Developer API — Rate Limits"

[2]: https://www.sebi.gov.in/reports-and-statistics/research/jul-2025/comparative-study-of-growth-in-equity-derivatives-segment-vis-vis-cash-market-after-recent-measures_95105.html "SEBI — Comparative study of growth in Equity Derivatives Segment vis-à-vis Cash Market after recent measures"

[3]: https://www.aqr.com/Insights/Research/White-Papers/Transactions-Costs-Practical-Application "AQR — Transactions Costs: Practical Application"

**Compliance disclosure:** This is research and analysis only, not personalized financial advice. Investing and trading involve risk, and paper-trading results are not guarantees of future performance.
