# Delivery cost and strategy research — October 4, 2026

Completed 16 real-data exploratory trials: eight fixed strategies under two delivery tariffs. No strategy passed admission. This pass changes backend research and execution-cost accounting; it does not change the UI or broker account.

The full [machine-readable report](delivery-cost-study-2026-10-04.json) contains every trial, admission failure, measured factor series, source hash and fixed specification. Experiment: `5835177a93ec3a47f395f5e3e3c68122a84655c78345482ba41abcf6a5aa79b2`.

## Actual results

Capital ₹10,000; planned loss at most 1% including estimated entry/exit fees and stop slippage; 15 basis points of slippage per leg; development July 15, 2024–July 28, 2025 (259 sessions). Same whole-share sizing, cash, portfolio caps and corporate-accounting rules for both tariffs. These are net simulated portfolio returns on already inspected history, not fresh validation or executable broker fills.

| Strategy | Current Upstox delivery tariff | Conditional Dhan delivery tariff |
|---|---|---|
| momentum_60d | -9.106% / 12 trades | Unavailable: corporate/delivery evidence |
| trend_pullback | -9.982% / 14 trades | -8.051% / 32 trades |
| breakout_20d | -9.738% / 13 trades | -7.862% / 29 trades |
| rsi2_reversion | -8.168% / 11 trades | -8.656% / 48 trades |
| momentum_6_12_monthly | Unavailable: corporate/delivery evidence | Unavailable: corporate/delivery evidence |
| momentum_6_12_weekly | Unavailable: corporate/delivery evidence | Unavailable: corporate/delivery evidence |
| breadth_quality_trend | +0.000% / 0 trades | +0.733% / 6 trades |
| breadth_efficient_trend_carry | -0.760% / 1 trades | -3.312% / 10 trades |

The conditional breadth-quality result is +0.733%, approximately ₹73.31, with six closed trades, profit factor 1.319 and drawdown 2.751%. Its 95% block-bootstrap interval for mean daily return is −0.022958% to +0.034193%. Only four of thirteen months were positive. Insufficient trades and an interval crossing zero prevent admission. The current-tariff version executes no trades; zero activity is not profit. Breakout results have missing held-price marks and are invalid for admission. Corporate/delivery failures retain null statistics instead of fabricated returns.

All seven previous current-tariff results reproduced within the declared tolerance, including corporate-evidence failures. Prefix-only feature computation reproduced the original features and avoids computing future development-irrelevant rows. The eighth strategy is a longer-hold hypothesis, not a profitable discovery: it ranks six-month momentum excluding the latest month, multiplied by 60-session price efficiency and divided by volatility. It also requires positive relative strength, rising EMA50, liquidity, breadth and volatility checks; uses a three-ATR initial stop and EMA200 exit, with at most 126 holding sessions. Price efficiency is absolute 60-session log-price displacement divided by the sum of absolute daily log returns. It is not a fundamental business-quality score.

## Why the amount affects execution

A flat charge consumes a larger percentage of a small position. A ₹20 charge alone is 1% of a ₹2,000 position, before the second order, DP charges, tax and slippage. The engine now evaluates both entry and exit costs against the cash and planned-loss budget before accepting whole shares. Raising hypothetical capital can change feasibility but does not establish an edge.

The tariff comparison uses published [Upstox pricing](https://upstox.com/brokerage-charges/) and [Dhan pricing](https://dhan.co/pricing/): respectively ₹20 and ₹0 delivery brokerage, plus their DP charges, STT, stamp duty, GST, exchange/SEBI/IPFT charges and modeled slippage. Charges are unrounded estimates; actual contract notes and account terms can differ. These present tariff scenarios are applied consistently to historical bars, not claimed to be historical account invoices. A zero-brokerage tariff still has trading costs. No account was opened or migrated. Free public NSE data remains the research source.

## Backend integration and evidence

- Research fee profiles flow through sizing, planned stops, fills, fee totals and cash reconciliation. Normal research and the configured broker remain on the current Upstox profile.
- `GET /api/research/delivery-costs` returns the actual retained comparison, or null if absent. It uses existing admin access and cannot place orders.
- Conditional alternative-tariff and exploratory comparison reports cannot seed a configured-broker forward cohort. Verification rejects a tariff mismatch even if the journal's price hashes match.
- Source price SHA: `b7640c8e375ef3609c49348735f1d8d785b680e0b4e80127d9c5cf771d774d7e`. Corporate-history SHA: `0095c10bb4d4d123a27bf6d502130e8533c16e7803613c0eb953a1713743aea2`.
- Historical membership, complete corporate coverage, original announcement times and share-delivery proof remain unverified. Daily OHLC bars do not prove executable fills. No reserved-period trial or live promotion was performed.

## Validation

195 Python tests passed, two skipped, three existing NumPy correlation warnings; 265 backend tests passed. Backend typecheck/build passed. Tests cover tariff-sensitive risk/cash accounting, unknown profiles, prefix-feature equivalence, price efficiency, conditional-cohort rejection and verifier mismatch. GitNexus was rebuilt (10,297 nodes, 22,287 edges, 351 flows). Comparison against master flags the accumulated worktree as CRITICAL: 70 tracked files, 316 symbols, 114 affected flows; new untracked modules require their separate review and tests. No commit or deployment was made.

The profit objective remains unmet. This evidence preserves the small positive exploratory result without converting it into unsupported buy/sell advice.
