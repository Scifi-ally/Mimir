# Mimir backend audit and Indian-market research — 4 October 2026

The backend is more reliable and reports less unsupported information. **Consistent profitability is not established.** The reproduced strategy validation fails. No replacement model was promoted and no broker orders were submitted.

The work used local open-source software and public resources. UI layout and styling were preserved; display expressions and API types changed so unavailable values stay unavailable, and a genuine zero return remains visible.

## Scope and architecture

Reviewed the working tree across ingestion, technical scanning, feature generation, Python inference, quantitative admission, learning, risk sizing, paper accounting, broker lifecycle, routes, browser data presentation, dependencies and CI. Existing uncommitted work was preserved. The principal path is:

`recorded/broker data → completed-session checks → scanner → measured features → inference → validated-model admission → portfolio risk → suggestions → execution/accounting`

GitNexus upstream impacts were run before symbol changes. Its initial query search failed because the Windows FTS extension cannot load; graph navigation and direct file review were used. HIGH/CRITICAL impacts were reported before changing shared scoring paths. An incremental index later returned inconsistent symbol identities; a forced rebuild without parser-cache reuse restored correct file-qualified lookups. This is a broad engineering audit, not proof that every dynamic path is defect-free.

## Implemented changes

1. **Source-provenanced factors.** `factor_observation.ts` records value, unit, source, observation/publication times, freshness budget, measurement/proxy kind and availability status. Non-finite, future, stale and undated observations become unknown. Actual zero values survive. Reading a cached observation cannot refresh its source timestamp.
2. **Measured-factor snapshots.** `measured_factors.ts` calculates eligible completed-bar price returns, gaps, range and turnover, carries aligned technical features, incorporates macro observations, and explicitly lists unsupported fundamental, news, event, depth and derivatives fields as missing. Snapshots accompany feature vectors and signal factors. They do not change the trained 32-feature array or claim predictive validation.
3. **Macro integrity.** Removed the fabricated India ten-year yield derived from a hardcoded repo rate. Yahoo quote timestamps and actual FII/DII report timestamps govern availability. Failed or expired observations clear old values. Public macro responses distinguish missing evidence from a heuristic stress score. The legacy geopolitical field is explicitly labelled a market-stress proxy.
4. **Model outage behavior.** Removed the TypeScript fallback that invented 90-day median/quantile forecasts and a neutral news score. Batch failure returns no model results. Per-candidate error placeholders are excluded. Forecast availability requires an actual model source, a finite return and valid forecast prices; an unavailable forecast returns null.
5. **Execution probability honesty.** System-1 serialization and native decisions publish null execution-success, stop-hunt and adverse-regime probabilities because no trading execution calibration artifact exists. Decision confidence is labelled a score, not a win probability. Unvalidated conviction cannot increase the published position multiplier.
6. **News eligibility.** Free RSS ingestion excludes undated, future and stale stories and deduplicates headlines. Public sentiment requires eligible stories and a functioning classifier. The TypeScript boundary independently validates source timestamps. A genuinely neutral classified result remains zero; missing evidence remains null. These classifier outputs have no established predictive return value.
7. **Historical timing.** Historical sentiment selection now requires both `filed_date` and `fetched_at` to precede the decision cutoff. A later backfill cannot leak into an earlier decision. New snapshot timestamps are timezone-aware UTC. Legacy snapshots still lack complete article/source provenance and are not presented as verified public news observations.
8. **Outcome evidence.** Removed unsupported 50% technical-edge/regime baselines. Diagnostic rates require at least 30 finite measured outcomes and include measured zero/loss outcomes. Symbol insights derive evidence from recorded closed suggestions rather than trusting legacy baseline rows. The panel no longer substitutes a technical score for an empirical outcome rate. These are suggestion diagnostics, not broker-verified net performance.
9. **Risk sizing.** Removed confidence boosts and Kelly sizing based on suggestion hit rates from final execution sizing. Base execution risk is at most 0.25% and can be lower when configuration or upstream limits require it. Upstream quantity/risk constraints remain binding. Learning suggestions may reduce risk; an old AGGRESSIVE payload cannot increase it.
10. **Cash accounting.** Delivery versus intraday treatment uses the actual trade type, not guesses from setup names. Paper exits use shared cash-equity cost functions, including brokerage, exchange/SEBI/IPFT fees, GST, stamp duty and the appropriate STT/DP treatment. The standard delivery assumption is INR20 per executed order. Account-specific charges, multiple fills and statutory rounding may differ. The checked schedule is [Upstox's official pricing](https://upstox.com/brokerage-charges/).
11. **Portfolio research.** Added a local daily equity/cash ledger with integer shares, next-open execution, gap-aware stops, fees, slippage, deployment/name/turnover caps and trailing correlation checks. Reports include drawdown, daily/monthly returns and bootstrap diagnostics. Missing held-position prices explicitly invalidate valuation evidence and exclude a candidate from selection.
12. **Dependencies and CI.** Updated compatible npm dependencies, removed an unused broker SDK with vulnerable transitive packages, and aligned both lockfiles. Updated/pinned FastAPI, Starlette, Pydantic, multipart, LightGBM, Transformers and the Chronos SDK. Chronos 2.3.2 supports the updated Transformers range; imports and dependency consistency were checked. CI now runs Python regressions and audits the root production workspace rather than a frontend lockfile that does not exist.

## What can currently be measured

The factor endpoints are `GET /api/market/factors` and `GET /api/market/factors/:symbol`. They expose coverage and source evidence, not trade recommendations. Coverage is never a probability of success. A snapshot can contain up to 40 fields when macro observations are present; availability depends on actual data, warmup, alignment and freshness.

| Factor family | Metric or representation | Current evidence |
| --- | --- | --- |
| Price/trend | 5/20/60/120-session returns, RSI, EMA distances, relative strength | Completed and aligned recorded bars only |
| Volatility | ATR%, ADX, realized volatility, range, gaps, band width | Eligible technical observations; adequate warmup required |
| Liquidity | Average close × volume turnover, volume ratio | Turnover is a proxy, not executable depth |
| Macro | VIX, USD/INR, Brent, DXY, US/India yields | Timestamped quotes; unavailable sources stay null |
| Institutions | FII/DII net flow in INR crore | Valid source report date; historical provenance is incomplete |
| News | Timestamped deduplicated classifier scores | Public only with valid feeds and classifier evidence |
| Valuation/fundamentals | P/E, growth, earnings surprise/date | Missing from the new verified snapshot until source ingestion is established |
| Policy/geopolitics | Surprise relative to prior expectations; event intensity/novelty | Not verified; existing keyword/stress rules are contextual proxies |
| Microstructure | Spread, book imbalance, market impact | No verified historical depth evidence in this research |
| Derivatives/breadth | Matched expiry/strike OI change; advance/decline ratio | New verified snapshot leaves these missing; existing live feeds require separate validation |

No system observes every cause of prices. Unrecorded orders, unexpected events and private information remain unknown. Converting a headline or policy decision into a number does not establish that the number improves trades.

## Actual profitability evidence

### Reproduced learned-ranker validation

Re-ran the existing purged walk-forward harness with the updated LightGBM environment against the recorded 12,893-outcome corpus. The result matches the prior failed validation. See [the new machine-readable report](quantitative-validation-2026-10-04.json).

| 28 monthly folds | Baseline costs | Additional 10 bps slippage per leg |
| --- | ---: | ---: |
| Selected outcomes | 876 | 876 |
| Mean net return per trade | -0.0229% | -0.2229% |
| Profit factor | 0.9811 | 0.8311 |
| Positive-outcome rate | 47.37% | 44.86% |
| Approximate 95% expectancy interval | [-0.3985%, +0.3527%] | [-0.5985%, +0.1527%] |

The uncertainty calculation groups outcomes by entry date and accounts conservatively for overlap. These are trade statistics; they are not a daily executable portfolio or full production-filter backtest. Point-in-time universe provenance is unverified. The admission result is **failed**.

### New portfolio hypotheses

Exported 119,374 daily bars from 97 recorded instruments through a read-only database transaction. Duplicate sessions and corrupt/zero-volume equity histories are conservatively truncated at the first ambiguity. The retained research dataset has 94 instruments and 78,649 bars; 579 invalid bars were identified before truncation. Corporate-action and historical-membership provenance remain unverified.

Four fixed long-only rule families were compared using INR500,000 starting capital, current delivery charges and 15 bps slippage per leg. Development dates are 20 July 2022–28 May 2025. A 20-session embargo precedes evaluation dates of 26 June 2025–28 September 2026. No valid positive development candidate was selected, so the later period was not searched for a winner.

| Development hypothesis | Diagnostic return | Trades | Valuation evidence |
| --- | ---: | ---: | --- |
| 60-day relative momentum | -0.0447% | 161 | Invalid: 336 missing held-position sessions |
| Trend pullback | -15.7703% | 477 | No missing held marks; source provenance unverified |
| 20-day breakout | -4.0248% | 172 | Invalid: 336 missing held-position sessions |
| RSI2 mean reversion | -26.9993% | 883 | No missing held marks; source provenance unverified |

The nearly flat momentum result is **not usable profitability evidence** because it depends on stale marks. The separate vendor-cache run also fails selection after that check. A cash-only or zero-trade evaluation cannot be interpreted as a profitable strategy. See [recorded portfolio research](portfolio-research-recorded-2026-10-04.json) and [cache diagnostics](portfolio-research-2026-10-04.json).

## Current technology research and free resource choices

- Keep the local LightGBM baseline and explicit cost/availability gates as the production research reference. More model complexity must demonstrate incremental net value on new data.
- [Amazon Chronos-2](https://huggingface.co/amazon/chronos-2) is Apache-2.0 and supports multivariate/covariate forecasting. It is an eligible research comparator, not evidence of Indian-market profitability. The upgraded SDK supports it; this work did not replace the serving model with newly downloaded weights.
- [Google TimesFM](https://github.com/google-research/timesfm) has newer multivariate capabilities. The downloaded TimesFM 3.0 weights prohibit commercial/production use; they do not fit this self-hosted profit project. Weights through 2.5 retain Apache-2.0 and are eligible for a separately validated comparison.
- [Qlib](https://github.com/microsoft/qlib/blob/main/LICENSE) is MIT-licensed and can support research organization. Its inclusion would not repair missing Indian point-in-time data or create an edge.
- [NSE's public historical reports](https://www.nseindia.com/static/resources/historical-reports-capital-market-daily-monthly-archives) are a source for recorded end-of-day data. Retain original reports, hashes, retrieval times, membership changes and corporate actions. Public access is not a promise of unrestricted data redistribution.
- Public RBI/company releases and available exchange reports can support timestamped event/fundamental ingestion. They do not provide an automatically complete free historical expectations/news/depth dataset. Unsupported fields should remain unknown until their records are collected and tested.

Software and research tooling can remain free/open-source. Market data services and a broker are external services; brokerage and statutory trading charges remain real costs. For live automation, [Upstox's current order-API requirements](https://upstox.com/developer/api-documentation/announcements/algo-trading-circular/) include the static-IP framework effective 1 April 2026. Signal-only research does not require placing orders.

## Evidence still required for deployment

Repair and verify the historical price gaps first. Reconstruct historical membership, delistings and corporate actions, then collect future observations with immutable source/publication records. Reserve new dates for forward paper evaluation of the actual signal, sizing and exit path. Register hypotheses before testing; report every trial rather than retaining only winners.

Promotion requires positive net expectancy under costs and stress, uncertainty bounds that exclude losses, adequate independent observations, sensible drawdown/capacity, and performance across relevant regimes. Proposed new factor/model families need incremental-value tests and calibration on untouched dates. The current ranker scope is five-session BUY cash equity; it cannot validate intraday, options or cash shorts.

The existing LIVE lifecycle still lacks a complete automated fill reconciler. Uncertain orders must remain reserved until confirmed reconciliation; an acknowledgment is not a fill. This work did not enable LIVE mode. Daily bars do not establish intrabar liquidity, and protective stops cannot guarantee execution through gaps. Exchange holiday/calendar and historical sector coverage also remain incomplete.

## Verification and reproduction

Final checks and logs are recorded in `.codex-logs`. The verified totals are 218 backend tests, 51 frontend tests and 111 Python tests, with two Python tests skipped. Backend typecheck and backend/frontend production builds pass. Model-library imports and `pip check` pass. Root and standalone backend **production** npm audits and the installed Python audit report no known vulnerabilities; this does not certify all development dependencies or every possible security issue.

```powershell
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix frontend test
npm --prefix backend run build
npm --prefix frontend run build
.venv/Scripts/python.exe -m pytest -q backend/ai_service
.venv/Scripts/python.exe -m pip check
npm audit --omit=dev
.venv/Scripts/python.exe -m pip_audit

# Read-only export uses the configured local database; no broker call.
.venv/Scripts/python.exe backend/scripts/export_research_candles.py --out .codex-logs/research-recorded-candles.json
.venv/Scripts/python.exe backend/ai_service/portfolio_research.py --data .codex-logs/research-recorded-candles.json --report docs/portfolio-research-recorded-2026-10-04.json
.venv/Scripts/python.exe backend/ai_service/walk_forward_harness.py --data .codex-logs/quant-training-clean.jsonl --report docs/quantitative-validation-2026-10-04.json
```

Walk-forward exit code 1 means the strategy failed admission; it does not indicate a software-test failure. Research scripts do not promote models or place orders. The database started for the read-only export was stopped after use. No commit was created; existing working-tree changes remain available for review.

Final GitNexus comparison against `master` reports 55 tracked changed files, 270 symbols and 100 affected processes with CRITICAL combined reach. That comparison includes pre-existing work; it is not a count of changes attributable only to this audit. New helper/test files were reviewed through their source and executable checks. The final forced index contains 9,914 nodes and 346 execution flows; keyword FTS remains unavailable.
