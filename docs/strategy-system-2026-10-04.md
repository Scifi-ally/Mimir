# Strategy research and forward evidence system

> Latest completed pass: [16-trial delivery-cost and eight-strategy study](delivery-cost-strategy-research-2026-10-04.md). All previous current-tariff controls reproduced. The conditional lower-cost breadth result was +0.733% with only six trades and failed admission; no profitability or live readiness is established. `GET /api/research/delivery-costs` serves its retained report. Validation now passes 195 Python and 265 backend tests. The older results below remain historical artifacts, not the latest engine run.

The latest [new strategy and measurable-factor report](breadth-strategy-research-2026-10-04.md) adds a seventh, breadth-filtered low-volatility trend rule, direct price-factor measurements, retained free macro observations and execution-cost sensitivity. Its completed seven-rule trial is published through the existing research API. No candidate qualified.

The latest [corporate-adjusted continuation](corporate-adjusted-research-2026-10-04.md) records the implemented causal indicator adjustments, completed retained corporate windows, real six-rule comparison and current validation. No strategy has qualified at the configured capital.

The latest [exchange strategy results and backend verification](exchange-strategy-results-2026-10-04.md) record the completed 803-session corpus, actual ₹10,000 comparisons, source integration, SDK repairs and outstanding accounting/profitability work. Earlier results below remain preserved.

The subsequent [exchange-evidence implementation report](exchange-evidence-2026-10-04.md) adds actual NSE archive collection, corporate-action receipts, replay verification, admission-policy freezing and API/scheduler integration. It records the latest validation and outstanding accounting work; the historical results below remain unchanged.

This implementation provides a reproducible research-to-shadow-paper workflow. It does **not** establish consistent profitability. All historical data in this project has already been inspected; later-period results are exploratory rather than a fresh untouched test. The UI layout is unchanged. No live broker orders or validated-model promotions were performed.

## Implemented

- Six deterministic strategy hypotheses: 60-session momentum, trend pullback, volume breakout, RSI2 reversion, and weekly/monthly six/twelve-month risk-adjusted momentum. The new family is inspired by [NSE's momentum methodology](https://niftyindices.com/indices/equity/strategy-indices/nifty200-momentum-30), with different universe, weighting, risk limits and execution. It does not replicate that index.
- Invalid and ambiguous duplicate sessions are individually quarantined. Incomplete/future daily bars are excluded until 15:30 IST. Stocks align to the recorded benchmark calendar; missing bars remain missing, never forward-filled tradable prices. Gaps invalidate affected rolling features. A missing held-position price invalidates portfolio evidence.
- Close-observed entry/exit rules execute at the next recorded open. Overnight stop gaps use the worse open. Integer shares, cash constraints, liquidity, correlation limits and aggregate exposure govern fills. Daily equity, fees, trades, exposure, drawdown and monthly results are recorded.
- The cash delivery cost model includes brokerage, STT, GST, exchange/SEBI/IPFT charges, buy stamp duty, sell DP charges and adverse slippage. Assumptions follow the [published Upstox schedule](https://upstox.com/brokerage-charges/). Income tax, market impact beyond the slippage assumption and exchange circuit/fill constraints are not established by daily bars.
- New experiments reject entries when estimated round-trip costs exceed 25% of the per-trade risk budget. Risk is 0.25% of equity per trade, maximum five positions, 20% per name and 80% deployment. A drawdown breach of 8% halts further entries and schedules liquidation; gaps can cause a larger realized loss.
- Each experiment freezes a manifest before simulation, hashes its input and engine/lab code, records all six development trials and selects only on development data. A 126-session embargo covers the longest holding horizon. Only the selected strategy is evaluated at 5 and 15 bps slippage per leg. Repeating an identical experiment retrieves its existing result rather than manufacturing a new independent trial.
- Evidence gates require sufficient trades, positive net return, acceptable drawdown, profit factor and a positive block-bootstrap lower bound. Unverified universe/corporate-action provenance and prior inspection independently prevent live admission. Statistical intervals are diagnostics, not a multiple-testing correction.
- Forward shadow portfolios freeze observations when first recorded, keep orders pending until the next session, and retain cash/open positions without daily end-of-backtest liquidation. Observation hash chains and a context hash detect altered recorded rows/warmup context. They reject incomplete/stale sessions, historical backfill, missed trading sessions, engine changes and strategy reselection inside an existing journal. These are simulated executions, not broker fills.
- Admin-protected backend APIs and a calendar-gated 16:10 IST scheduler job integrate the workflow, including published normal-hour weekend sessions. An exclusive local filesystem lock prevents overlap between API and engine processes sharing this workspace. Crashed-worker locks require review; they are not silently stolen.
- Runtime market status, previous/completed/next-session helpers and research now share the sourced NSE normal-session calendar for 2025/2026, including the January 15, 2026 amendment and February budget weekend sessions. The earlier hard-coded calendar had incorrect holiday dates. Muhurat/nonstandard-hour sessions are excluded from normal-session automation. Other legacy jobs with weekday cron expressions still need manual operation on extraordinary weekend sessions; this pass changes the forward-evidence job only. Years outside the sourced calendar retain compatibility behavior and are explicitly unverified.
- Actual missing research and forward performance is returned as `null`/`ABSTAIN`; no sample profits or mock strategy results are generated.

## Reproduced results

The source is the project's read-only export of recorded candles, not independently verified point-in-time exchange data. Current membership can introduce survivorship bias. Corporate actions and missing sessions still need independent verification.

| Experiment | Development | Later evaluation | Decision |
|---|---|---|---|
| Repository default ₹10,000 capital, cost gate enabled | All six families execute zero economically acceptable trades | Not evaluated: no candidate qualified | ABSTAIN; zero return is no trading activity, not a profitable strategy |
| Separate ₹5 lakh diagnostic comparison, corrected calendar | Monthly momentum +1.213%, 38 trades; weekly +11.065% rejected for a missing held mark | Monthly −1.482% at 5 bps; −1.550% at 15 bps; 12 trades, two missing held-price sessions | Reject promotion; evaluation invalid and losing |

The ₹5 lakh comparison does not change the user's configured trading capital. The full artifacts are [default-capital results](strategy-lab-default-capital-2026-10-04.json) and [capital comparison](strategy-lab-capital-comparison-2026-10-04.json). Prior ranker and four-family experiments remain in the earlier audit reports; they are not replaced with favorable statistics.

## Run from the project root in PowerShell

Python requirements and Node dependencies must be installed. `MIMIR_PYTHON` can specify an executable; otherwise the backend finds the local `.venv` or `python`.

```powershell
# Export and validate the retained public NSE corpus; no database or broker connection.
.venv\Scripts\python.exe backend/ai_service/nse_archive.py --directory backend/data/exchange_archive --export backend/data/strategy_lab/exchange-candles.json

# Use actual intended capital explicitly for standalone research.
.venv\Scripts\python.exe backend/ai_service/strategy_lab.py --data backend/data/strategy_lab/exchange-candles.json --directory backend/data/strategy_lab --capital 10000 --risk-policy total_loss_budget --maximum-risk-pct 1 --corporate-archives backend/data/exchange_archive/historical_corporate

# Observe one completed current session. Never backfills forward performance.
.venv\Scripts\python.exe backend/ai_service/strategy_forward.py --data backend/data/strategy_lab/exchange-candles.json --directory backend/data/strategy_lab --archives backend/data/exchange_archive
```

The existing application provides:

- `GET /api/research/strategies`: current worker state, actual research artifact and actual forward status (null if absent).
- `POST /api/research/strategies/research`: prefers a completed sufficiently populated official exchange corpus, otherwise exports recorded database candles. It freezes an experiment using `getConfig().tradingCapital`. Returns 202; poll GET for completion/error and report.
- `POST /api/research/strategies/forward`: retains the frozen experiment's source kind and captures a current completed session for shadow tracking. No selected strategy returns ABSTAIN without inventing forward statistics.
- Engine scheduler: attempts the same forward capture at 16:10 IST on normal sessions in the shared calendar. A market holiday does not generate observations or trades.

Remote access uses the existing admin token policy. Request bodies cannot change file paths, shell commands, mode or capital. Runtime evidence lives in ignored `backend/data/strategy_lab/`; historical report exports in `docs/` are review artifacts. Use a separate directory for a new forward experiment; never rewrite an old experiment to change its strategy.

The journal's first context contains historical features observed at activation, not historical forward performance. Later daily rows are frozen as observed. Local hashes detect ordinary accidental corruption; they are not signatures against an attacker who can rewrite the entire workspace. Treat local vendor timestamps as weaker evidence than an independently recorded exchange feed.

## Technology and further evidence

The existing free open-source stack is retained: TypeScript/Express, PostgreSQL/Redis, Python/FastAPI, NumPy/pandas and LightGBM. The preceding audit upgraded vulnerable runtime dependencies and verified current Chronos SDK compatibility. [Chronos-2](https://huggingface.co/amazon/chronos-2) offers an Apache-2.0 forecasting model, but a forecast is not an admitted trading edge; no weights or trading model were promoted during this pass. [Qlib](https://github.com/microsoft/qlib) provides open-source research machinery, but does not supply verified Indian historical membership/corporate-action data. Adding a framework cannot correct those source gaps.

The measured-factor API from the preceding audit exposes actual observed price/volume/technical/macro measurements with provenance and availability. Unsupported fundamentals, depth and other factors remain explicitly missing. Broad research supports testing momentum/trend hypotheses; it does not prove this project earns money after Indian fees. More factors are useful only when timestamped data and incremental forward predictive value are demonstrated.

No paid software or cloud services were introduced. Brokerage charges are real costs of trading; free software does not eliminate them. Exchange-based research and forward observations use retained official archives; vendor-source experiments require the configured local database. Live promotion remains blocked until source defects and fresh forward evidence are resolved.

## Validation

The full Python suite passed: 120 tests, two skipped. The 16 research/execution tests include quarantine, future-bar exclusion, costs, next-open chronology, gap stops, cash reconciliation, forward idempotency, missing-session refusal, tamper detection, frozen-engine checks and the shared calendar. The full backend suite passed: 241 tests, including four new API tests and 19 calendar regressions. Backend typecheck/build and `git diff --check` passed. A real TypeScript-to-Python forward worker smoke run completed with `ABSTAIN`, null statistics and no live admission. The previous pass also verified frontend tests/build; this pass did not edit frontend files.

GitNexus comparison against `master` covers the entire existing working tree: 60 tracked files, 277 symbols and 110 affected processes, rated CRITICAL. Most of that scope predates this pass. New untracked research/calendar modules also received manual review and targeted tests; the tracked-diff report alone does not cover them. No commit or deployment was made, and pre-existing changes were preserved. Calendar helper impacts were HIGH/CRITICAL and were reported before editing.

Calendar sources are the [2025 annual circular](https://nsearchives.nseindia.com/content/circulars/CMTR65587.pdf), [2025 budget-session circular](https://nsearchives.nseindia.com/content/circulars/CMTR65729.pdf), [2026 annual circular](https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf), [January 15 amendment](https://nsearchives.nseindia.com/content/circulars/CMTR72260.pdf), and [2026 budget-session circular](https://nsearchives.nseindia.com/content/circulars/CMTR72349.pdf). Amendment dates matter: a settlement-only holiday notice was superseded by a trading-holiday amendment, so the exchange's final trading circular was used.
