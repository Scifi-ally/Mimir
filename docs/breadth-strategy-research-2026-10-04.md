# New strategy, measurable factors and execution economics

Implemented a seventh strategy, `breadth_quality_trend`, and tested it on the retained official NSE corpus with causal corporate adjustments. The completed report is now available through the existing backend research API. It avoided the losses of the four scored legacy rules by rejecting all eleven proposed entries. It has not demonstrated a profitable edge: zero trades means inactivity, not profit.

## Fixed strategy hypothesis

The new rule combines volatility-adjusted relative momentum with liquid-market participation and a transaction-cost hurdle. Its name refers to price-trend filters; verified fundamental accounting quality is not supplied. NSE's [momentum methodology](https://niftyindices.com/indices/equity/strategy-indices/nifty200-momentum-30) motivates volatility-adjusted momentum, but this rule differs in universe, weights, timing and execution. No index performance is transferred to this system.

At each completed close, rank up to 500 observed equities by trailing 20-session rupee turnover, requiring at least ₹5 crore/day and 200 measurable names for breadth. This is the observed research universe, not independently verified historical Nifty membership.

Entry requires at least 60% of those names above both EMA50 and EMA200, positive median 20-session momentum, NIFTY above EMA50 above EMA200, and annualized 20-session NIFTY volatility no greater than 25%. A stock must have close > EMA20 > EMA50 > EMA200, at least 8% sixty-session momentum, 12% 126-session momentum, three percentage points of sixty-session relative strength, positive twenty-session momentum, ATR/price no greater than 1.5%, and EMA20 extension no greater than 6%. Rank the survivors by equal-weight sixty/126-session momentum divided by 126-session daily-return volatility.

Entries are considered weekly, with an initial-cohort observation allowed, and fill at the next open. The initial stop is 1.5 ATR below signal close. Maximum holding time is 63 sessions. EMA50 loss, market breadth below 40%, unavailable breadth, or NIFTY falling below EMA200 schedules a next-open exit. Overnight and intraday stops retain the existing adverse execution rules.

Integer shares, 20% name cap, 80% deployment cap, five positions, turnover/correlation constraints and the eight-percent drawdown halt remain. Planned loss includes both fee legs and adverse stop slippage, limited to configured risk at most 1%. An extra hurdle requires estimated round-trip friction to consume at most one third of the observed sixty-session price movement at the proposed position size. That historical movement is a scale reference, not an expected return or win probability. Gaps can exceed the planned loss budget.

The normal research worker now explicitly uses this total-loss policy. This changes its earlier implicit 0.25% stop-only research budget to the configured cap, including charges; it is a research-policy change, not permission for live orders. Standalone CLI callers retain their explicit risk-policy choice.

## Measured factors and free sources

| Condition | Metric | Source and availability |
|---|---|---|
| Broad participation | Fraction above EMA50/200; median twenty-session momentum; observed-name count | Retained free NSE daily archives; timestamp-local computation |
| Trend/relative momentum | EMA ordering/distances, sixty/126/252-session returns, relative return to NIFTY | Corporate-adjusted research indicators; raw observed prices retained |
| Volatility | ATR/price; realized return standard deviation; annualized NIFTY volatility | Completed daily prices |
| Liquidity | Mean close × volume over twenty sessions; volume ratio | Completed daily prices; turnover is a liquidity proxy |
| Execution friction | Rupee round-trip cost; fraction of risk budget; required break-even move | Published tariff plus explicit slippage assumption |
| Currency/energy/global rates | USD/INR, DXY, Brent, US ten-year yield | Actual free Yahoo quote feed with provider timestamp and capture time |
| Domestic stress and flows | India VIX; FII/DII net flow in INR crore | Free quote/NSE feeds; missing fields stay null |

The public per-stock factor endpoint now computes RSI, ATR, ADX, EMA distances, volume ratio, Bollinger bandwidth, 20/60/126-session realized volatility and 126/252-session return directly from completed valid bars. It no longer needs an AI feature vector to expose those observations. Each indicator requires its full minimum history, so indicator helper defaults cannot masquerade as measured values. These API measurements use the supplied candle price basis; they do not independently certify corporate adjustments. The fixed 32-feature ranker input schema was unchanged.

Macro fetches now write sanitized, content-addressed receipts into ignored `backend/data/factor_archive/`. Extra payload fields are excluded, values/time validity is rechecked, future/nonfinite data cannot become available, and an existing changed receipt is rejected. Tests mock the archive hook so fake test quotes are not written as runtime evidence.

The real free-feed smoke check retained [this receipt](free-factor-receipt-2026-10-04.json), hash `72d8e9374e79acd0fcf7b869c09d57018ccac11d1a32e55df9346752835c140d`: seven available source observations and a null India ten-year yield. Capture time is October 4, 2026 at 16:51:46 UTC; individual source times differ. Quotes/receipts are not independently certified or predictive validation. This first receipt cannot manufacture a historical macro backtest. The new strategy currently uses the price-derived factors, while macro history is collected for prospective incremental-value testing.

Fundamental surprises, timestamped historical financial statements, news event effects, policy surprises, depth and historical membership remain incomplete. Missing factors are explicit; the system does not claim to measure every market influence. Research breadth timestamps represent bar completion, not verified historical archive-publication or receipt times.

## Actual real-data result

Experiment `4b9c72bbfb1fbe0abcbfbcecdda4f3ec3a7abd94e78b147ac92bc8a1107d0cda` froze all seven hypotheses before simulation. Price and corporate inputs retain the earlier verified hashes. Capital was ₹10,000, total planned-loss cap 1%, and adverse slippage 15 bps per leg. Development is July 15, 2024–July 28, 2025; the 126-session embargo and reserved later interval remain. All inspected history is exploratory.

The custom rule records 259 daily factor observations. There were 112 days satisfying its measurable breadth, median-momentum and volatility thresholds before the additional NIFTY, stock and weekly filters. Eleven attempted entries were rejected: seven by capital/risk constraints and four by the observed-movement cost hurdle. No trades, no fees and no return resulted. No strategy was selected and no reserved evaluation was run. The [complete seven-rule result](strategy-lab-breadth-quality-2026-10-04.json) preserves the rejected losing/invalid baselines and the new policy/factor observations.

The exact report, manifest and corporate input were published locally under the exclusive worker lock after checking engine/price hashes, configured capital/risk and absence of an active forward journal. Forward recording and verification then completed, returning actual ABSTAIN/null statistics. Earlier reports remain preserved. UI layout, broker configuration and live-order authorization were unchanged.

## Concrete cost constraint

The separate [execution-economics artifact](execution-economics-2026-10-04.json) estimates a twenty-share ₹100 reference-price position, ₹2,000 notional, fifteen bps slippage per leg and ₹100 planned-risk budget:

| Published delivery tariff scenario | Flat-price round-trip loss | Required underlying price move to break even |
|---|---:|---:|
| Current Upstox | ₹81.25 | 4.073% |
| Dhan delivery cost scenario | ₹25.20 | 1.263% |

The calculation uses [Upstox's published charges](https://upstox.com/brokerage-charges/) and [Dhan's tariff](https://dhan.co/pricing/), including mandatory charges and DP. It uses unrounded charge estimates; actual contract-note rounding can differ. The cheaper scenario is not a trading backtest, an account migration or a forecast. Dhan's trading API is free, while its [market-data API subscription is paid](https://dhan.co/support/platforms/dhanhq-api/how-to-access-dhan-api/). Free NSE EOD collection remains the research data plan. No account, credentials or execution broker was changed.

This identifies the next meaningful research constraint: test the strategy with authenticated actual lower-cost execution terms before claiming it can generate economically viable trades. Increasing features or relaxing filters on this already inspected corpus is not fresh profitability evidence. No paid models, software or data subscriptions were introduced.

## Checks

Full Python validation passed 188 tests, with two skipped and three warnings. The full backend suite passed 264 tests, including factor/archive/worker checks. Typecheck, production build, `git diff --check`, published-artifact/engine hash consistency, actual macro-receipt hash, forward/admission experiment IDs and lock cleanup checks passed. No real broker orders, deployment or model promotion occurred.

The final full GitNexus refresh indexes 10,279 nodes, 22,213 edges and 352 flows. The accumulated tracked comparison against `master` still reports CRITICAL combined reach: 70 files, 316 symbols and 114 affected flows, including earlier work. New untracked strategy/factor/economics modules are outside tracked-diff detection and received explicit review and executable checks. GitNexus FTS is unavailable and bounded/cross-language graph omissions limit scope inference. No commit was created.
