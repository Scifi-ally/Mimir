# Mimir Signal and Profitability Audit

**Author:** Manus AI
**Repository:** [Scifi-ally/Mimir](https://github.com/Scifi-ally/Mimir)
**Audit date:** 17 August 2026
**Scope:** Signal generation, ranking, calibration, outcome labeling, position sizing, paper execution, risk controls, testing, and reproducibility.

> **Finance disclaimer:** I’m an AI, not a licensed financial advisor—this is analysis, not guaranteed advice; investing carries risk you bear. The recommendations below are engineering and research recommendations, not a promise of profitability.

## Executive conclusion

Mimir has a comparatively mature signal stack: market-regime detection, multi-timeframe checks, adaptive weighting, learned-ranker integration, live-price entry gates, database-backed capacity controls, and a tick-aware outcome tracker. The repository’s automated tests are healthy at the unit level: **20 backend test files and 66 backend tests passed; 3 frontend test files and 6 frontend tests passed; the backend build passed**.

The main limitation is not a missing indicator. It is **measurement inconsistency**. Mimir currently has multiple definitions of a trade, fill, exit, cost, and outcome. The signal learner consumes outcomes from `suggestionsTable`, while the paper engine independently calculates position P&L. Those two paths use different fills, exit behavior, and fee models. As a result, the system can improve its measured win rate or expectancy while actual executable P&L moves in the opposite direction.

The highest-return engineering priority is therefore to create **one canonical event-sourced trade ledger** and make signal training, calibration, paper execution, live reconciliation, and reporting consume the same realized events. Only after that should Mimir optimize thresholds, weights, Kelly fractions, or new features. More indicators before fixing label and execution integrity would increase the risk of overfitting rather than improve the edge.

## Priority summary

| Priority | Finding | Severity | Expected impact | Recommended action |
|---|---|---:|---|---|
| P0 | Outcome tracker and paper engine use separate economic truth | Critical | Can invalidate calibration and profit claims | Build a canonical fill/exit ledger and derive all outcomes from it |
| P0 | Paper execution can force one share above the requested risk budget | High | Risk cap can be violated on small accounts or wide stops | Remove unconditional minimum quantity or explicitly reject un-sized trades |
| P0 | Realtime orchestrator constructs synthetic feature scores | High | Training data and live ranking can contain fabricated/placeholder factors | Route realtime candidates through the same feature and ranker contract as batch signals |
| P1 | Target-1/target-2 semantics differ across signal, tracker, and paper engine | High | Win rate and R-multiple statistics are not comparable | Define partial-exit policy and implement it consistently |
| P1 | Cost model is inconsistent and incomplete | High | Net expectancy can be overstated | Centralize broker/exchange/tax/slippage calculations and use them everywhere |
| P1 | Kelly comments and implementation disagree; paper engine floors negative edge to 0.20% | High | Losing or uncertain trades can still receive risk | Use a single sizing function and return zero for non-positive net edge |
| P1 | Swing/intraday classification is inferred inconsistently | Medium | Margin release and cost behavior can be wrong | Persist and use `tradeType` directly; never infer it from symbol/setup text |
| P1 | Ranker confidence lacks production calibration monitoring | Medium | A 0.58 probability may not mean 58% in live data | Add walk-forward reliability, Brier score, ECE, and drift gates |
| P2 | Fixed score normalizations saturate and hide regime dependence | Medium | Ranking loses resolution at extremes | Replace hard-coded transforms with point-in-time, regime-aware transforms |
| P2 | Setup demotion uses small, noisy windows and hard binary switches | Medium | Temporary noise can disable a profitable setup | Use shrinkage, confidence intervals, and gradual allocation changes |
| P2 | Test suite lacks end-to-end economic invariants | Medium | Unit tests can pass while live and tracker outcomes diverge | Add deterministic replay tests from ticks through ledger and P&L |
| P2 | Backend lockfile is not reproducible with `npm ci` | Medium | Clean CI/deploy installs fail | Regenerate and commit a consistent lockfile under the project’s Node/npm version |

## Detailed findings

### 1. Canonical trade truth is missing — P0

`accuracy_tracker.ts` resolves suggestion outcomes from prices and applies a flat `COST_RATE_PER_SIDE` of 0.05% per side. The paper engine separately creates positions, applies observed spread slippage, applies brokerage and STT, and updates account balances. The tracker writes `suggestionsTable.pnlInr`, whereas the paper engine writes `paperPositionsTable.realizedPnl`.

This creates two different economic histories for the same signal. Calibration reads `suggestionsTable` outcomes in `calibration_engine.ts`, so learned confidence, setup demotions, and Kelly inputs are trained on tracker economics rather than necessarily realized paper/live economics. The mismatch is especially material for gap fills, wide spreads, circuit-limit exits, brokerage minimums, and symbols with different liquidity.

**Recommended fix.** Introduce an immutable `trade_events` table containing signal creation, entry intent, fill, partial fill, stop/target trigger, execution fill, fees, slippage, and final close. The paper engine should append execution events. The outcome tracker should only identify trigger conditions; it should not independently finalize P&L. A single reducer should derive position state, suggestion status, realized P&L, R-multiple, and training labels. The reducer must be deterministic and replayable from an ordered event stream.

**Acceptance test.** Replaying the same tick and execution-event fixture must produce identical `suggestionsTable` outcome, `paperPositionsTable` realized P&L, account balance delta, and training label. No component should calculate a second independent P&L.

### 2. Risk-budget violation from forced minimum quantity — P0

In `paper_engine.ts`, quantity is calculated with `Decimal.max(1, riskAmount.div(stopDistance).floor())`. That guarantees at least one share even when one share’s stop-loss loss exceeds the configured risk budget. The subsequent margin check verifies available margin, not risk-budget compliance.

This is a direct risk-control contradiction: the UI may display a configured maximum risk while the paper/live sizing logic knowingly exceeds it. The safe behavior is to reject the trade when the risk budget cannot buy one unit, unless the instrument supports fractional quantities and the broker contract explicitly allows them.

**Recommended fix.** Replace the forced minimum with `floor(riskAmount / stopDistance)`. If the result is below one, reject with `risk_budget_too_small`. Add a regression test asserting that actual stop-loss loss is never greater than the configured risk amount, apart from explicitly modeled gap/slippage loss.

### 3. Realtime path fabricates feature fields — P0

The realtime ranking path in `intelligence/orchestrator.ts` constructs an `IntelligenceSignal` with `patternScore`, `chronosScore`, and `technicalScore` all set to 50, `sector` set to `Unknown`, `positionSize` set to 1, and an `atr14` proxy derived from entry-to-stop distance. It then sends this synthetic object through ingestion.

This is not merely a presentation issue. If these rows feed calibration, outcome analysis, or future ranker training, the system is learning from a different feature distribution than the one used by the batch pipeline. The synthetic `Unknown` sector and placeholder scores also make attribution and regime analysis less trustworthy.

**Recommended fix.** Reuse the exact `FeatureVector` and score construction used by `runIntelligencePipeline`. The realtime ranker should return a typed candidate result, not a partially fabricated `IntelligenceSignal`. If a feature is unavailable, mark the candidate incomplete and reject or route it to a separately labeled fallback dataset; never fill missing predictive features with 50 solely to satisfy the schema.

### 4. Target and exit semantics are inconsistent — P1

The signal and tracker support `target1` and `target2`, while the paper engine’s exit path uses `suggestion.target1` as the exit target and closes the full position. The tracker can label `TARGET_2_HIT`, and calibration treats both target statuses as wins. This makes a `TARGET_2_HIT` outcome potentially represent a different execution process from the paper position.

The tracker also uses a conservative stop-first convention when a single observed print is ambiguous, while the paper engine has its own tick-driven exit path. Without a single policy, target hit rate, average P&L, MFE/MAE, and R-multiple statistics are not directly comparable.

**Recommended fix.** Choose and encode one policy: either full exit at T1, or a defined partial exit such as 50% at T1 and 50% at T2 with a specified stop adjustment. Store every fill and residual quantity. Define deterministic same-tick precedence, gap handling, and whether a stop/target is considered triggered by trade price, bid/ask, or executable side of the book.

### 5. Transaction-cost and slippage accounting is inconsistent — P1

The tracker’s flat per-side cost rate does not match the paper engine’s observed half-spread, fallback slippage, brokerage, and STT calculations. The circuit-limit exit path also has a separate P&L calculation that does not visibly apply the same brokerage/STT schedule as the normal exit path. Fixed percentages are not sufficient for minimum brokerage, taxes, exchange fees, GST, stamp duty, or symbol-specific spread behavior.

**Recommended fix.** Create a pure `calculateExecutionEconomics()` module that accepts side, quantity, price, instrument, trade type, broker schedule, observed quote, and slippage policy, then returns gross value, each fee component, slippage, and net P&L. Use it in the tracker, paper engine, backtest/replay code, and reports. Store fee components rather than only a final net number.

### 6. Kelly sizing is not one policy and does not consistently reject negative edge — P1

Both risk sizing and paper sizing use a factor of `0.20`, while comments describe this as quarter-Kelly. More importantly, the paper engine computes a non-negative Kelly result but later clamps risk to a minimum of `0.20`, meaning a negative or unproven empirical edge can still receive risk. The risk engine’s separate sizing function can return zero in the same conceptual situation.

**Recommended fix.** Centralize sizing. Use a conservative Bayesian probability estimate, not a raw observed win rate; subtract expected round-trip costs and gap/slippage loss from payoff; use a single fractional-Kelly factor configured in one place; and return zero for non-positive net expectancy. Keep a separate minimum trade-size rule that rejects rather than overrides the risk cap.

### 7. Trade type is inferred inconsistently — P1

The suggestion ingestion path persists `tradeType`, but paper sizing infers swing status from setup text containing `swing` or `cnc`, while exit margin release checks whether the symbol contains `-SWING`. This can misclassify a swing position as intraday and release the wrong amount of margin. The classification should be a persisted field carried from signal creation through execution and reconciliation.

**Recommended fix.** Use `suggestion.tradeType` directly for leverage, settlement, fee schedule, overnight-risk policy, and exit accounting. Add a test for each supported trade type and remove text-based inference.

### 8. Confidence is not demonstrated to be a probability — P1

The ranker path gates on a minimum win probability and blends it into confidence. The legacy path uses hard-coded score transforms, clipping, and adaptive linear weights. The empirical calibrator blends observed setup win rate into a 0–100 score, but there is no visible production reliability report showing whether predicted probabilities match realized frequencies.

**Recommended fix.** Evaluate every model version with purged, walk-forward splits. Report reliability bins, Brier score, log loss, calibration slope/intercept, precision at selected operating thresholds, net expectancy after costs, turnover, maximum drawdown, and performance by regime/setup/direction. Do not call a score “confidence” or “probability” unless it has passed a calibration test on untouched forward data.

### 9. Hard-coded normalization loses information — P2

Relative strength is mapped through a fixed 0.8–1.2 range and sector strength through a fixed −2% to +2% range, both clipped to 0–100. This means many extreme observations become identical 0 or 100. The score can therefore rank a moderately strong stock and an exceptionally strong stock equally, while the same raw value may have different meaning across volatility regimes.

**Recommended fix.** Use point-in-time cross-sectional percentile ranks or robust z-scores computed only from information available at decision time. Condition transforms by regime and horizon. Persist the universe snapshot and transform parameters for replay.

### 10. Binary setup demotions are vulnerable to selection noise — P2

`refreshSetupDemotions()` disables a setup after a negative average realized P&L over a rolling 90-day window with a minimum of 15 trades, and setup×regime cells use 30 trades. This is directionally sensible but statistically fragile, especially when the number of simultaneous setups, market regime, and selection thresholds change over time. A negative mean after 15 or 30 trades is not by itself strong evidence that the true expectancy is negative.

**Recommended fix.** Use shrinkage toward a global/setup prior, confidence intervals or posterior probability that expectancy is below zero, and a graduated allocation multiplier. Add hysteresis so a setup is not repeatedly enabled and disabled around zero.

### 11. Backtest and replay discipline is insufficiently explicit — P2

The repository contains strong comments about walk-forward optimization, but the audit did not find a single self-contained command that rebuilds the full signal-to-execution result from point-in-time market data with versioned configuration, model artifact, universe, fees, and latency assumptions. The core tests are unit/regression tests, not a full economic replay.

**Recommended fix.** Add a replay harness with: immutable market-data snapshots; point-in-time universe membership; no future corporate-action or earnings leakage; model/config version hashes; realistic order latency; bid/ask or conservative spread simulation; partial fills/gaps; fees; and a frozen out-of-sample period that is never used for tuning. Emit a trade-level ledger and summary metrics from the same reducer used in paper mode.

### 12. Clean installation is not reproducible — P2

The initial `npm ci` path failed for the backend because `backend/package-lock.json` was inconsistent with the declared dependency graph, including esbuild platform packages and missing transitive packages. A fallback `npm install` allowed tests to run, but it modified the lockfile locally; the audit restored the tracked lockfile and made no repository changes.

**Recommended fix.** Regenerate the backend lockfile with the project’s supported Node/npm version, commit it, and add a clean-install job to CI. Treat dependency audit findings separately from signal quality, but address the reported production dependency vulnerabilities before live deployment.

## Recommended implementation sequence

| Phase | Deliverable | Success criterion |
|---|---|---|
| 1 | Canonical event ledger and deterministic P&L reducer | Tracker and paper engine agree on every replay fixture |
| 2 | Unified fill, fee, slippage, target, and stop policy | Net P&L and R-multiple are identical across paper, replay, and reports |
| 3 | Safe sizing rewrite | No trade can exceed risk budget because of a forced minimum quantity; negative edge sizes to zero |
| 4 | Realtime feature-contract unification | Realtime and batch candidates share schema, feature provenance, and model version |
| 5 | Walk-forward evaluation harness | Every model release has untouched-forward metrics and calibration report |
| 6 | Threshold and allocation optimization | Thresholds maximize net expectancy subject to drawdown and turnover constraints, not raw win rate |
| 7 | Feature experiments | Add only features that improve forward net expectancy after costs and survive ablation tests |

## Signal-improvement experiments worth running after the P0 fixes

The most promising experiments are not “add more indicators.” They are targeted tests with an explicit control group and an untouched forward period. First, compare entry timing policies—immediate market entry, limit-at-trigger, and pullback entry—using the same candidate set and realistic spread/latency. Second, test regime-conditional thresholds and position caps rather than a single global confidence floor. Third, replace raw win-rate calibration with Bayesian or isotonic calibration and compare net expectancy, Brier score, and drawdown. Fourth, test volatility-scaled exits and time stops, but only with labels generated by the canonical execution reducer. Fifth, assess cross-sectional ranking and portfolio construction: select the top expected net-R trades subject to correlated-sector and direction exposure instead of accepting each signal independently.

For each experiment, freeze the universe, data snapshot, model version, fee schedule, and random seed. Report gross return, net return, hit rate, average win, average loss, profit factor, expectancy per trade, turnover, exposure, maximum drawdown, Calmar/Sharpe where appropriate, tail loss, and performance by setup, regime, direction, and liquidity bucket. A change should be promoted only when its improvement persists in the untouched forward slice and does not come from a small number of outliers.

## Audit validation performed

| Check | Result |
|---|---:|
| Backend tests | **Passed: 20 files, 66 tests** |
| Frontend tests | **Passed: 3 files, 6 tests** |
| Backend build | **Passed** |
| Initial clean backend install with `npm ci` | **Failed: lockfile inconsistency** |
| Production dependency audit from root | **6 vulnerabilities reported: 2 moderate, 4 high** |
| Repository modifications | **None retained; lockfile restored** |

## Final recommendation

Do not optimize for a higher displayed win rate first. Optimize for **trustworthy net expectancy under forward replay**. The immediate engineering work should make every accepted signal traceable from feature snapshot to intended order, actual fill, fees, exit event, realized P&L, and training label. Once those numbers are unified, Mimir can safely tune thresholds, ranker calibration, regime gating, and risk allocation. Until then, “maximize profit” is not measurable enough to optimize reliably.

## References

[1]: https://github.com/Scifi-ally/Mimir "Scifi-ally/Mimir repository"
[2]: https://github.com/Scifi-ally/Mimir/blob/master/backend/src/analysis/signal_generator.ts "Mimir signal generator"
[3]: https://github.com/Scifi-ally/Mimir/blob/master/backend/src/analysis/risk_engine.ts "Mimir risk engine"
[4]: https://github.com/Scifi-ally/Mimir/blob/master/backend/src/suggestions/generator.ts "Mimir suggestion ingestion"
[5]: https://github.com/Scifi-ally/Mimir/blob/master/backend/src/suggestions/accuracy_tracker.ts "Mimir outcome tracker"
[6]: https://github.com/Scifi-ally/Mimir/blob/master/backend/src/trading/paper_engine.ts "Mimir paper trading engine"
[7]: https://github.com/Scifi-ally/Mimir/blob/master/backend/src/analysis/calibration_engine.ts "Mimir calibration engine"
[8]: https://github.com/Scifi-ally/Mimir/blob/master/backend/src/intelligence/orchestrator.ts "Mimir realtime orchestrator"
