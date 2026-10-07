# Exchange strategy results and backend verification

For the subsequent corporate-action implementation, corrected receipt handling and latest test results, see [the corporate-adjusted continuation](corporate-adjusted-research-2026-10-04.md). The raw-price comparisons below are preserved as earlier research artifacts.

The exchange research pipeline is implemented and exercised. None of the tested strategies has established a profitable edge at the configured ₹10,000 capital. The actual system state is ABSTAIN with null forward performance. The profitability objective remains unmet.

## Actual source coverage

Public NSE collection finished with 803 validated normal sessions from July 3, 2023 through October 1, 2026. Raw equity and NIFTY reports are retained and reparsed to validate stored prices. The export contains 3,194 instrument histories including NIFTY; 2,539 satisfy the loader's minimum history requirement. Its research panel contains 2,038,817 aligned rows, including missing rows retained as NaN. Export SHA-256: `b7640c8e375ef3609c49348735f1d8d785b680e0b4e80127d9c5cf771d774d7e`.

Collection recorded 23 HTTP 404 dates, principally unsourced-calendar holidays in 2023/2024. They are unavailable dates, not fabricated sessions or retrospectively certified holidays. No invalid downloaded reports were accepted. Earlier weekend/nonstandard sessions remain incomplete. All historical receipts were obtained during this collection; historical publication or receipt time is not established.

Prices are raw. Corporate actions, dividend payments, share availability and adjusted indicators remain material limitations. The full-year 2024/2025 corporate request is rejected for conflicting duplicate metadata; its raw response is retained. Three other historical windows succeeded. Historical corporate responses do not prove announcement timestamps or settlement.

## Actual frozen strategy comparison

The six rules were fixed before simulation. Development ran July 15, 2024–July 28, 2025 after warmup. A 126-session embargo separates the reserved February 2–October 1, 2026 interval. No candidate qualified, so that interval was not evaluated. This downloaded corpus is now inspected history; rerunning it cannot create a fresh holdout.

Both comparisons use ₹10,000, integer shares, delivery fees, 15 bps adverse slippage per leg and exposure/liquidity/correlation limits. The default legacy cost screen permits zero trades. A separate alternative includes both fee legs and stop slippage inside the configured 1% planned-loss budget, retaining the 8% drawdown halt. Gaps can exceed the budget. Fee assumptions follow the [published Upstox schedule](https://upstox.com/brokerage-charges/).

| Fixed strategy | Alternative development return | Closed trades | Missing held-price sessions | Drawdown halt |
|---|---:|---:|---:|---|
| 60-session momentum | −9.334% | 12 | 61 | Yes |
| Trend pullback | −10.035% | 14 | 0 | Yes |
| 20-session breakout | −9.738% | 13 | 78 | Yes |
| RSI2 reversion | −8.122% | 11 | 0 | Yes |
| Monthly six/twelve-month momentum | −1.785% | 3 | 201 | No |
| Weekly six/twelve-month momentum | −2.783% | 4 | 201 | No |

All fail selection. Missing held prices invalidate portfolio evidence; raw corporate-action limitations affect every candidate. These are rejected diagnostics, not tradable return estimates or a claim about every possible strategy.

Actual artifacts: [exchange alternative](strategy-lab-exchange-2026-10-04.json), experiment `f7a406ec111ab27267e4ed014eecbbc8f1ea8082d1682fe801a676027c7ff4ea`, and [default worker](strategy-lab-exchange-default-2026-10-04.json), experiment `bf957d17247280f9aeeee6b13354aa8b641266f47ff0b04ab1949a1172ce0849`. Earlier artifacts remain preserved. Metadata/engine reruns on the same prices are not independent trials.

## Backend implementation

- The normal worker prefers a sufficiently populated completed exchange corpus, reparses retained bytes, validates export provenance and freezes source kind/price basis. Exchange and vendor exports use different paths. Forward journals reject a source-kind switch.
- Corporate refresh runs 07:30 IST, including holidays. Forward capture selects a validated retained pre-open receipt; an evening refresh cannot replace it. Exchange-based forward capture retries after evening archive collection. Missed forward sessions are never backfilled.
- Yahoo Finance v3 now uses an actual shared SDK instance. Five static import paths and lazy earnings loading previously called migration stubs that throw before requesting data. This follows the [official upgrade instructions](https://github.com/gadicc/yahoo-finance2/blob/dev/docs/UPGRADING.md).
- A real NIFTY vendor request returned 1,025 intraday timestamp slots, including null holiday slots. It is retained locally as unverified research input; it is not 1,025 executable bars or admitted strategy evidence.
- Divergence requires fresh finite dated flows and six closes aligned to their five sessions. Missing data is null, and the cache expires after 15 minutes so temporary failures can recover. The ±10 adjustment remains a heuristic, not a calibrated or profitable predictor.
- Benchmark data is null for missing account/trades/source or unverified open-position marks. A measured return difference is separate from statistical alpha, which remains null. Recorded paper trades are not untouched out-of-sample results.
- Unavailable per-stock options OI and stale/absent order-flow readings are null. Inference no longer substitutes invented VIX, institutional flow or risk/reward measurements. These auxiliary fields are outside the frozen 32-feature ranker contract.

## Verification and remaining work

All 254 backend tests and 166 Python tests passed; two Python tests were skipped. Typecheck, production build and `git diff --check` passed. Three Python warnings concern the installed test-client API and a deliberately constant correlation fixture. The real TypeScript-to-Python research/forward worker selected official data, completed without a database export or broker connection, and returned actual ABSTAIN/null forward statistics. Locks were released. UI layout was unchanged in this pass; no orders, deployment or model promotion occurred.

Raw evidence is in ignored `backend/data/exchange_archive/`; runtime reports are in `backend/data/strategy_lab/` and exposed through existing research/data APIs. The broker token inspected earlier is expired; authenticated broker history and fill evidence are unavailable.

The final full GitNexus refresh succeeded: 10,171 nodes, 21,865 edges and 347 indexed flows. Keyword FTS remains unavailable, and the graph reports bounded traversal/cross-language coverage limitations. Comparison against `master` reports CRITICAL combined reach across 70 tracked changed files, 316 symbols and 114 affected flows, including prior work. Untracked additions are outside tracked-diff detection and received explicit source review and executable checks. No commit was created.

Corporate accounting, indicator adjustment, settlement/source verification, calendar evolution across a prospective cohort, executable-fill evidence and genuinely fresh strategy validation remain unfinished. The verifier withholds admission while corporate accounting is uncertified. No claim of consistent profit or a complete profitable trading system is supported.
