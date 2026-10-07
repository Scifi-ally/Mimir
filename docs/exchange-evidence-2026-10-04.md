# Independent exchange evidence and strategy verification

The [latest exchange strategy results](exchange-strategy-results-2026-10-04.md) supersede the progress status below: collection completed with 803 sessions, six strategies were tested, and backend validation reached 254 tests plus 166 Python tests. Profitability remains unproven.

The strategy backend now retrieves actual free NSE equity, index and corporate-action records. It preserves the UI layout and does not place orders. This is progress toward reliable research; consistent profitability has not been demonstrated.

## Recorded findings

A read-only query of the existing local configuration confirmed ₹10,000 capital, PAPER mode, paper trading enabled, ₹20 configured brokerage and 5 bps slippage. No configuration or order was changed. The portable database started for that query was stopped afterwards.

Actual public exchange downloads succeeded for:

| Session | Equity format | Tradable EQ instruments | Independent benchmark |
| --- | --- | ---: | --- |
| July 3, 2023 | Legacy bhavcopy | 1,764 | NIFTY 50 OHLCV |
| March 18, 2025 | UDiFF | 2,048 | NIFTY 50 OHLCV |
| October 1, 2026 | UDiFF | 2,662 | NIFTY 50 OHLCV |

All were received on October 4, 2026 and are explicitly historical backfills. Three nonconsecutive sessions are insufficient for a strategy backtest. Their publication dates are not fabricated historical receipt times.

On March 18, 86 cached project instruments matched the exchange by ISIN. All 86 cached volumes were zero, while exchange records reported actual trades. Some cached adjusted prices differed materially from raw exchange prices, including Siemens following corporate restructuring. The collector keeps raw exchange data separate; splicing it into adjusted vendor history would introduce false returns.

The public corporate-action feed returned 465 EQ events for September 4–November 3, 2026. Actual response bytes, hashes, receipt times, ISINs, ex-dates and purpose descriptions were preserved. Missing announcement, payment and share-delivery timestamps remain unverified. The free PR report ZIP also contains a BC corporate-action CSV with both current and upcoming ex-dates; the parser preserves these distinctions.

Sources: [NSE reports](https://www.nseindia.com/all-reports), [NSE report formats](https://www.nseindia.com/static/resources/forms-formats-members), [public corporate actions](https://www.nseindia.com/companies-listing/corporate-filings-actions). These are public data sources, not software licences; the collector is for this local research application.

## Implemented verification

`nse_archive.py` validates report schema, dates, instrument identity, finite OHLCV, executable volume, duplicate identities and file bounds. It keeps raw source bytes and immutable session receipts with checksums. No missing data is forward-filled. `nse_corporate_archive.py` archives real corporate responses; a failed/invalid response produces unavailable coverage and null events, never a fabricated empty calendar.

`strategy_verification.py` validates the frozen journal context and observation chain, experiment/strategy/capital/engine identities, and prospective receipt times. It compares each forward row against independently archived NSE raw prices by ISIN and replays the frozen portfolio to check reported statistics and portfolio state. Altered returns and altered recorded rows fail verification. Local hashes detect corruption; a person who can rewrite the entire workspace can also rewrite hashes.

Admission criteria are frozen at cohort creation in `strategy_promotion.py`: at least 252 fresh observed sessions, 30 closed trades, positive net return, profit factor ≥1.1, drawdown ≤8%, positive lower block-bootstrap confidence bound, 15 bps adverse slippage per leg, cost filtering, complete independent verification and corporate-action accounting. Signal admission never authorizes broker orders. Old cohorts without the frozen policy hash do not silently gain admission.

Corporate-action cash/share accounting is still unresolved. The verifier reports it explicitly and withholds admission; downloading ex-date records alone cannot prove the portfolio handled dividends, bonus-share delivery, splits, rights and demergers correctly. Warmup indicators remain frozen research inputs rather than independently certified measurements. These are outstanding work, not completed validation.

The next pass adds `corporate_accounting.py`: a tested entitlement ledger separates dividends receivable from settled cash, refuses to create tradable undelivered shares, preserves fractional entitlements, handles idempotent cash-credit and whole-share balance proofs and flags unsupported rights/demerger terms. Replay verification now reports corporate events crossed by actual replayed holdings. These are accounting primitives and exposure diagnostics; they are not yet incorporated into simulator returns, so corporate accounting admission remains withheld. Twelve accounting/verifier tests passed after this addition. The ledger expects proof inputs to have been independently validated; a boolean supplied to a pure function is not independent verification.

A read-only credential-metadata query on October 4 found one persisted trading-token entry from October 1 with a 24-hour lifetime, already expired, and no data-token entry. No token value was selected or logged, no authentication state was changed, and the database process started for this query was stopped afterwards. Authenticated longer intraday downloads therefore remain unavailable with the current credentials. Public exchange collection remains available.

## Simulator integration and longer history

The simulator now accepts explicit corporate events and settlement receipts. Dividend entitlements enter economic equity without funding fills; date-only cash credits become available after that session's execution. Settled credits reconcile closed-trade results with equity, including actual withholding. Whole-share credits require proven pre-open availability, conserve entry cost and cannot round fractional claims into tradable shares. Unsupported corporate terms or unresolved share delivery stop the simulation rather than reporting misleading returns. This does not independently authenticate supplied statement proofs.

Forward jobs now require retained corporate coverage received before the session open and freeze the day's event inputs and receipt hash into the observation chain. The verifier validates retained source bytes and replays those same inputs. Research, recorder and verifier pin a combined simulator/accounting fingerprint. Independent complete coverage, indicator adjustment basis and broker execution remain outstanding admission requirements.

The updated ₹10,000 experiment is retained in [accounting-engine research results](strategy-lab-accounting-2026-10-04.json): all six candidates still execute zero development trades under the existing economic filter; there is no selected strategy or manufactured evaluation return. A real forward worker check completed with ABSTAIN and null statistics. Full Python validation passed 153 tests, two skipped; four subsequently added corporate-receipt/backfill tests also passed. Existing backend tests/build passed in the preceding pass; this pass changes Python logic and research artifacts.

`exchange_backfill.py` is collecting the bounded July 3, 2023–October 1, 2026 public NSE corpus with at least two seconds between uncached sessions, preserved raw bytes, per-session validation and resumable receipts. Its runtime `backfill-status.json` records actual progress and gaps. A source denial or rate limit stops collection without bypass. Collection is ongoing, not a completed dataset or a validated backtest. Every downloaded observation remains a historical backfill; no fresh holdout evidence is invented. Weekend/nonstandard coverage before the verified 2025/2026 calendar remains a research limitation.

## API and schedule

- `GET /api/research/data`: actual exchange and corporate archive statuses; null if absent.
- `POST /api/research/data/collect`: protected local worker downloads official configured sources. Body fields cannot supply URLs, paths, dates, capital or shell commands.
- `GET /api/research/strategies`: actual research, forward and verification/admission artifacts.
- Research, forward capture and exchange collection recompute the admission report. The exchange scheduler runs at 19:10 IST on normal sessions; forward observation remains 16:10 IST.

Runtime source bytes and evidence stay in ignored `backend/data/exchange_archive/` and `backend/data/strategy_lab/`. No sample profits are returned when evidence is absent. The actual ₹10,000 experiment currently reports ABSTAIN, with no qualifying strategy or invented forward returns.

```powershell
.venv\Scripts\python.exe backend/ai_service/nse_archive.py
.venv\Scripts\python.exe backend/ai_service/nse_corporate_archive.py
.venv\Scripts\python.exe backend/ai_service/strategy_verification.py --directory backend/data/strategy_lab --archives backend/data/exchange_archive
```

Further work requires corporate-action accounting, a complete independent historical corpus for exploratory research, and fresh observed evidence of an economically viable strategy at the actual intended capital. Historical performance remains exploratory.

## Validation in this pass

The full Python suite passed 139 tests with two skipped; after adding the retained-source reparsing regression, all 12 archive/verifier tests also passed. The full backend suite passed 243 tests. Typecheck, production build and `git diff --check` passed. Real TypeScript-to-Python forward and archive worker checks completed successfully, returned honest ABSTAIN/no fabricated performance, and left no worker locks. No broker orders were placed; order log messages in the test suite came from mocked test fixtures.

GitNexus was refreshed with a full parse: 10,068 nodes, 21,516 edges and 343 indexed flows. FTS is unavailable on this Windows installation, so concept queries report that limitation and navigation falls back to graph context and text search. The complete working-tree comparison against master remains CRITICAL: 60 tracked files, 277 symbols and 110 affected processes, largely from earlier passes. This is a regression-review warning, not a clean isolated change set. New untracked modules are not covered by tracked-diff detection; they received explicit review and tests. No commit or deployment was made.

A separate read-only database coverage query found 8,484 hourly bars for 84 instruments from September 10–October 1, and 7,140 four-hour bars from August 3–October 1. Volumes were nonzero. These short windows are not adequate independent evidence for an intraday strategy. Any intraday research must use its own fees, chronology and validation; delivery-model performance cannot be transferred to it.
