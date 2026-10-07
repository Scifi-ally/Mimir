# Corporate-adjusted research continuation

The corporate-action-aware backend is implemented and its real-data comparison completed. No tested strategy qualified for signals. Profitability remains unproven. This report supersedes the corporate-window and indicator implementation status in [the earlier exchange report](exchange-strategy-results-2026-10-04.md); its earlier raw-price results remain historical artifacts.

## Retained official inputs

The existing 803-session NSE price corpus is unchanged. Four historical corporate-response windows now validate, supplemented by the retained current window. Their union covers July 3, 2023–October 1, 2026. The previously rejected 2024/2025 response contained complementary missing metadata in duplicate meeting notices. The collector merges only such notice metadata, retains both original variants, and still rejects conflicting specified fields or economic terms.

The frozen corporate input contains 7,930 distinct events: 5,633 dividends, 1,589 meeting notices, 173 bonuses, 175 splits and 360 unsupported terms. SHA-256: `0095c10bb4d4d123a27bf6d502130e8533c16e7803613c0eb953a1713743aea2`. Receipt coverage proves coverage of requested response windows; it does not independently prove absence of omissions, historical announcement times, or account settlement.

## Implemented accounting and indicators

- Raw OHLCV remains the execution tape. Split, bonus and cash-dividend adjustments affect indicators on or after the ex-date. Previously computed earlier signals are preserved. Raw traded rupee turnover remains the liquidity input.
- Fractional bonus volume bases use floating-point working data without rounding or altering raw integer volumes. Missing ex-date/cum-date prices, unsupported terms and ambiguous simultaneous economic actions disable the affected indicators.
- Combined meeting/dividend wording is decoded only when its cash terms are explicit. Meeting notices have no invented economic entitlement.
- Dividend claims are separate from spendable cash. Additional shares cannot fund a sale until delivery is verified. Missing share-delivery evidence invalidates the candidate, with null statistics.
- Frozen corporate inputs are hash checked. Forward processing carries those historical inputs and retained forward-session events. Source kind and corporate hashes are checked during verification. Overlapping receipt metadata retains earlier specified fields, so an intervening missing value cannot conceal a later contradiction; a regression reproduced and now rejects that case.
- The normal exchange research worker passes a fixed corporate archive path. Worker tests verify shell-free argument handling, configured capital, export failure behavior and lock cleanup. The bounded subprocess timeout is 20 minutes.

These changes do not independently certify announcement chronology, event completeness, adjusted indicators, settlement or daily-bar execution liquidity. Corporate-accounting verification continues to withhold admission.

## Actual comparison

Experiment `063944a799f79cce9804c12f6f296dd623c63b63b3499501e855b6ab64bf1615` uses ₹10,000, the alternative 1% planned-loss budget including both fee legs and stop slippage, 15 bps adverse slippage per leg, integer shares and the existing exposure/correlation constraints. Development is July 15, 2024–July 28, 2025. No candidate qualified, so the reserved evaluation interval was not evaluated.

| Fixed rule | Development diagnostic return | Closed trades | Missing held-price sessions | Result |
|---|---:|---:|---:|---|
| 60-session momentum | −9.106% | 12 | 0 | Drawdown halt |
| Trend pullback | −9.982% | 14 | 0 | Drawdown halt |
| 20-session breakout | −9.738% | 13 | 78 | Invalid marks; drawdown halt |
| RSI2 reversion | −8.168% | 11 | 0 | Drawdown halt |
| Monthly six/twelve-month momentum | Unavailable | Unavailable | Unavailable | Corporate/share-delivery evidence unverified |
| Weekly six/twelve-month momentum | Unavailable | Unavailable | Unavailable | Corporate/share-delivery evidence unverified |

The full [machine-readable artifact](strategy-lab-corporate-adjusted-2026-10-04.json) preserves receipt metadata, indicator diagnostics and admission failures. Reusing this already inspected history is exploratory research, not new independent validation. Negative figures above are rejected diagnostic outputs, not executable return forecasts.

Short-hold candidate fees total ₹789–₹1,003 for just 11–14 closed trades. At this capital, fixed delivery charges consume much of the risk budget. A larger model or more market inputs alone does not resolve those costs. Fees are based on the [published Upstox cash delivery schedule](https://upstox.com/brokerage-charges/), not a fictional zero-cost broker.

## Verification

The full Python suite passed: 180 tests, two skipped, three warnings. All 256 backend tests passed, as did TypeScript typecheck, production build and `git diff --check`. The warnings concern the installed test-client API and a deliberately constant correlation fixture. Published artifact bytes match the runtime report; its manifest and price/corporate hashes match the retained inputs. UI layout was unchanged in this continuation. No real broker orders or model promotion were performed.

The final GitNexus full refresh indexes 10,215 nodes, 22,018 edges and 349 flows. Keyword FTS remains unavailable, and bounded traversal/cross-language omissions limit the graph. Comparison against `master` reports CRITICAL combined reach across 70 tracked files, 316 changed symbols and 114 affected flows, including earlier work. Untracked additions are outside tracked-diff detection; they received source review and executable checks. No commit was created.

The real TypeScript-to-Python normal-worker run completed research, verification and forward status successfully. It selected official exchange/corporate inputs at configured ₹10,000 capital, released the worker lock, and returned ABSTAIN with null forward statistics and no admitted signals. All six rules executed zero development trades under the default legacy cost filter. Zero return here is inactivity, not profit. The [default corporate-aware artifact](strategy-lab-corporate-default-2026-10-04.json) is experiment `2e951474661921fc36d51ba26d5fd64f0ffffd67650b9662c3dc03d3cd73d63f`; it uses the same price/corporate hashes as the alternative-policy comparison. No database export or broker connection was needed. These runs are not independent validation trials.

Remaining work includes independent corporate completeness, historical announcement chronology, instrument identity transitions, delivery/settlement evidence, indicator certification, calendar evolution across a prospective cohort and executable-fill verification. No profitable candidate exists to start a qualified forward cohort. The profitability objective is unmet; neither backfilled research nor software tests establish consistent profits.
