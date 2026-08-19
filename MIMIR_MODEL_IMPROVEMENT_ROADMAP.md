# Mimir Model-Improvement Roadmap

**Repository:** `Scifi-ally/Mimir`
**Audited revision:** `9cfcb58`
**Basis:** Existing source code, committed model artifacts, training scripts, serving code, and the analysis-system report. This is a software/model audit, not a claim that any proposed change will improve trading returns.

## Executive conclusion

Yes. The documentation reveals several concrete improvement opportunities. The highest-value work is **not immediately changing the neural or tree-model hyperparameters**. The strongest opportunities are first to correct measurement and deployment weaknesses: improve label semantics, expand point-in-time validation, make model status truthful, strengthen sentiment timestamp handling, and add model-drift monitoring. Only after those controls are in place should Mimir compare new Chronos, FinBERT, LightGBM, or RL variants.

The current LightGBM ranker is promising but not yet sufficiently validated for confident optimization conclusions. The committed metadata shows test AUC **0.723** and greenlight expectancy **1.25%** versus **0.62%** for taking all test trades, but the test slice contains only **100 observations**, with **28 greenlit trades**.[1] Those figures justify further investigation, not automatic belief that the model has a durable edge.

## Priority matrix

| Priority | Improvement | Why it matters | Expected effort | Recommendation |
|---|---|---|---:|---|
| P0 | Fix label/objective semantics | Timeout trades are partly relabeled as wins, despite the documented target being target-before-stop | Medium | Do before retraining |
| P0 | Strengthen point-in-time sentiment controls | RSS timestamps, feed latency, deduplication, and historical/live alignment can affect leakage and reproducibility | Medium | Do before trusting sentiment lift |
| P0 | Make production model status truthful | `/health` currently emphasizes Technical Engine and Chronos and can report AI ranking without proving ranker availability | Low | Safe engineering fix |
| P0 | Add walk-forward confidence intervals and segment metrics | One 100-row test window is too small for robust model-selection conclusions | Medium | Do before hyperparameter tuning |
| P1 | Add model/version/drift monitoring | No systematic detection of feature drift, calibration drift, source failure, or live-vs-backtest divergence is documented | Medium | Add before continuous retraining |
| P1 | Calibrate all score-producing systems | Technical probability, Chronos direction, and sentiment composite are not all empirically calibrated for decision use | Medium | Validate component-level calibration |
| P1 | Improve ranker feature quality | Sector RS is hardcoded to `1.0` during extraction; live-only fields are excluded, and microstructure features are absent from training | Medium | Rebuild only with point-in-time data |
| P1 | Benchmark Chronos against simple baselines | The fallback and naïve price/return forecasts may be competitive; no documented baseline comparison is present | Medium | Required before changing Chronos |
| P2 | Improve FinBERT inference and aggregation | Explicit truncation, batching, source weighting, deduplication, and neutral handling can improve reliability | Low–Medium | Test as an incremental experiment |
| P2 | Train confluence artifacts or simplify the path | The model is implemented but no `.pkl` artifacts are present; current fallback is arithmetic | Low–Medium | Either complete deployment or remove ambiguity |
| P2 | Decide whether RL belongs in production | PPO exists but is not connected to the standard batch signal path and has no artifact | High | Deprioritize until supervised baselines are strong |

## 1. P0: Correct the training target before changing models

The training extractor describes the label as “1 if the trade hit target1 before stop.” However, a `TIMEOUT` trade is assigned label 1 whenever its net return is positive, and label 0 otherwise.[2] This creates a mixed objective:

```text
WIN    -> label 1
LOSS   -> label 0
TIMEOUT -> label based on net return sign
```

That may be a reasonable business objective, but it is **not the same objective** as `P(target1 before stop)`. The ranker metadata and serving comments currently describe the latter. A model trained on the former will produce probabilities that are not strictly interpretable as target-before-stop probabilities.[2] [3]

### Recommended fix

Choose one explicit target and use it consistently:

| Objective | Correct label definition | Serving interpretation |
|---|---|---|
| Target-before-stop | `1` only for target hit before stop; `0` for stop or censored timeout | `P(target before stop)` |
| Positive net outcome | `1` for net-positive realized outcome; `0` otherwise | `P(net-positive trade)` |
| Time-to-event | Separate event type and resolution time | Probability of event by horizon |

The most rigorous option is to retain `outcome`, `retPct`, `resolutionTs`, and censoring status separately, then train either a competing-risk/time-to-event model or two heads: target-hit probability and expected net return. Until that is implemented, the lowest-risk change is to use a strict target-before-stop label and keep timeout return as a separate regression/evaluation field.

## 2. P0: Improve validation before tuning hyperparameters

The current artifact reports strong-looking performance, but the test slice has only 100 rows and the threshold selects 28 trades.[1] A single chronological holdout can still be dominated by one market regime, one setup mix, or one symbol cluster. The repository already contains a purged walk-forward harness with structural breaks, embargo, and optional rolling windows, which is a good foundation.[4]

### Required validation additions

| Test | What to report |
|---|---|
| Purged walk-forward by time | Fold AUC, Brier, calibration slope/intercept, take-all expectancy, greenlight expectancy |
| Regime segmentation | Results in trending, sideways, high-volatility, and risk-off periods |
| Direction segmentation | BUY versus SELL performance |
| Setup segmentation | Pullback, momentum, EMA reclaim/rejection, MACD crossover |
| Symbol concentration | Number of symbols, top-symbol share of rows and P&L |
| Bootstrap uncertainty | Confidence intervals for AUC, expectancy, hit rate, and drawdown |
| Threshold stability | Chosen threshold by fold, not only one global value |
| Cost sensitivity | Results under higher spread, slippage, and execution costs |

A model should not be promoted solely because the aggregate average improves. Require improvement across a minimum number of independent folds and reject a challenger whose gains come from one short period or one setup family.

## 3. P0: Make sentiment point-in-time safe and reproducible

The FinBERT model is real and integrated, but sentiment quality depends heavily on news retrieval and timestamp handling. The current implementation parses RSS publication dates, assigns unparseable dates an effective age of 24 hours, and uses current time for recency weighting.[5] For live scoring that may be acceptable; for historical evaluation it is not sufficient unless every headline has a verified publication timestamp strictly before the decision time.

### Specific improvements

1. Store a unique headline identifier, source, URL, publication timestamp, retrieval timestamp, model version, and raw FinBERT output.
2. Deduplicate headlines across feeds before aggregation. The same story appearing in Moneycontrol, Economic Times, and LiveMint should not receive three independent votes unless source diversity is explicitly intended.
3. Require `published_at < decision_timestamp - latency_buffer` for historical scoring. A practical buffer should be tested rather than assumed.
4. Preserve both raw FinBERT scores and keyword scores so the model can be audited after a trade.
5. Add source-level failure and coverage metrics. A “neutral” score caused by a feed outage must be distinguishable from genuinely neutral news.
6. Evaluate FinBERT contribution against a no-news baseline, a keyword-only baseline, and a source-specific baseline.

The current five-minute cache and 20-second failure cache are sensible operational defaults, but they are not model-quality validation. The system should log whether a result was full FinBERT, keyword-only, neutral, cached, or historical.[5]

## 4. P0: Correct health and deployment truthfulness

The service health logic currently makes overall AI status depend primarily on the Technical Pattern Engine and Chronos. The learned ranker is loaded separately and reports its own status, while confluence and RL artifacts can be absent without making the overall status clearly explain which decision systems are degraded.[6] This can lead operators to believe that “AI Ranking” is active when the ranker has no artifact or LightGBM is unavailable.

### Safe engineering changes

The `/health` response should expose a normalized status for every component:

| Component | Required fields |
|---|---|
| Chronos | loaded, healthy, checkpoint, fallback_active, inference latency |
| FinBERT | initialized, loaded, last error, feed coverage, fallback mode |
| Technical Engine | loaded, healthy, engine version |
| Learned ranker | loaded, artifact hash, feature count, trained_at, threshold, metrics |
| Confluence | loaded regimes, artifact count, fallback status |
| RL | artifact present, loaded, training status |

The top-level mode should say something like **“Chronos + FinBERT + ranker active; confluence fallback; RL unavailable”** rather than a single broad “AI Mode.” This is a high-confidence improvement because it does not alter trade logic; it reduces silent misconfiguration.

## 5. P1: Improve ranker feature quality and data coverage

The ranker feature contract itself is strong: it has 32 ordered fields and explicitly rejects incomplete vectors.[7] However, the training extractor passes `1.0` as sector relative strength when sector data is unavailable, and passes undefined bid/ask imbalance and options OI fields into feature construction.[2] These choices may create low-variance or artificial feature distributions.

### Recommended experiments

| Experiment | Hypothesis | Acceptance test |
|---|---|---|
| Add point-in-time sector benchmark data | Sector-relative strength improves discrimination | Positive incremental OOF AUC and expectancy across multiple folds |
| Remove or isolate unavailable live fields | Placeholder-heavy fields may create spurious patterns | Compare feature importance and fold stability |
| Normalize heavy-tailed flow features | Raw FII/DII values may be scale-sensitive | Better calibration and lower cross-symbol drift |
| Add setup type and direction carefully | Different setups may have distinct base rates | Improvement must survive symbol/time splits |
| Add transaction-cost and liquidity features | Gross signals may not survive execution | Net expectancy after conservative costs improves |

Do not add live-only fields merely because they improve an in-sample score. Every new feature must be reconstructable from information available at the historical decision timestamp.[2] [7]

## 6. P1: Calibrate the full decision stack

The learned ranker has an isotonic calibration layer, but the Technical Pattern Engine's sigmoid output and the Chronos forecast-return mapping are hand-designed rather than empirically calibrated. The sentiment composite is also a weighted score, not a probability.[1] [3] [5]

This creates a scale mismatch: the final confidence may combine calibrated ranker probability with uncalibrated technical, forecast, confluence, and sentiment components. The 70/30 ranker blend is reasonable as a temporary policy, but it should be treated as a decision heuristic until calibration is measured.[9]

### Recommended calibration work

1. Calibrate Technical Pattern Engine bullish probability against realized outcomes by regime and direction.
2. Compare Chronos median-return buckets with realized forward returns; replace the fixed sigmoid multiplier `3.0` if a learned monotonic mapping is demonstrably better.
3. Calibrate sentiment score buckets against next-day or next-horizon returns, while controlling for market regime.
4. Use out-of-fold component predictions to train the confluence model, rather than fitting the combination layer on in-sample component outputs.
5. Report reliability diagrams and expected calibration error for every probability-like output.

## 7. P1: Benchmark Chronos against simple baselines

Chronos should not be improved by replacing it with a newer checkpoint until it beats simple baselines under the same walk-forward setup. The current implementation includes a momentum/mean-reversion fallback but does not document a formal comparison against naïve last-value, drift, moving-average, or volatility-adjusted return baselines.[1]

### Minimum Chronos experiment set

| Baseline | Forecast |
|---|---|
| Last value | Every future close equals the latest close |
| Drift | Latest close plus historical average return drift |
| EMA | EMA-based continuation |
| Mean reversion | Existing deterministic fallback |
| Chronos-Bolt-Small | Current pretrained model |
| Return-space model | Forecast log returns and reconstruct prices |

Measure median absolute error, directional accuracy, quantile coverage, interval width, and downstream trade expectancy. The best forecast model is not necessarily the model with the lowest price error; it is the one whose forecast improves the final decision after costs and risk controls.

## 8. P1/P2: Improve FinBERT usage without assuming more model complexity is better

The current sentiment design already has a useful fallback chain. The most promising improvements are aggregation and data hygiene rather than replacing FinBERT immediately.

### Low-risk FinBERT experiments

| Change | Benefit to test |
|---|---|
| Explicit batch size and truncation policy | More predictable latency and input behavior |
| Headline deduplication | Prevent repeated stories from dominating the score |
| Source reliability weighting | Reduce low-quality or duplicative feed influence |
| Neutral-zone handling | Avoid treating weak positive/negative probabilities as conviction |
| FinBERT confidence threshold | Route low-confidence outputs to neutral or keyword review |
| Sector/symbol relevance filter | Reduce broad macro headlines contaminating symbol-specific scores |
| FinBERT versus keyword-only ablation | Quantify whether the model adds value over deterministic rules |

A FinBERT change should be accepted only if it improves out-of-fold sentiment-return association or downstream trade expectancy without increasing latency or creating a point-in-time violation.

## 9. P2: Complete or remove ambiguous model paths

The confluence LightGBM and PPO paths are implemented but not active because their artifacts are absent.[8] [10] [12] This creates unnecessary complexity and operational ambiguity.

For confluence, choose one of two paths:

| Option | When appropriate |
|---|---|
| Complete training and artifact promotion | If regime-gated combinations consistently beat the native fallback across purged folds |
| Remove from the production decision path | If the arithmetic fallback is equal or better and the trained model adds maintenance cost |

For PPO, the evidence is weaker. The RL agent is trained on a simple reward, a five-action environment, stitched ticker data, fixed PCR, and only 20,000 timesteps.[11] It is also exposed through a separate endpoint rather than integrated into the main batch signal path. It should therefore be **deprioritized**, not promoted, until it demonstrates improvement over the supervised ranker and deterministic rules under the same walk-forward and cost assumptions.

## 10. Monitoring and continuous learning

The repository contains lifecycle triggers for ranker and RL training, but the documentation does not show a complete production monitoring loop that automatically detects drift and safely rejects weak retrains.[13] The ranker already has a champion-challenger gate, which is a good foundation.[14]

Add the following monitoring fields to every prediction and trade outcome:

| Monitoring area | Required measurement |
|---|---|
| Feature drift | PSI or quantile drift for every ranker feature |
| Prediction drift | Distribution of raw and calibrated probabilities |
| Calibration drift | Reliability and Brier score by rolling window |
| Outcome drift | Hit rate and expectancy by setup, direction, regime, symbol |
| Sentiment drift | Feed coverage, FinBERT failure rate, keyword-only rate, score distribution |
| Chronos drift | Forecast-return distribution and realized forecast error |
| Execution drift | Fill rate, slippage, spread, timeout rate |
| Versioning | Model hash, feature-manifest hash, training data range, threshold, code revision |

Retraining should be triggered by a monitored schedule or drift condition, but promotion should require the same purged walk-forward champion-challenger gate. The system should never hot-swap a challenger solely because it is newer.[14]

## 11. Recommended sequence of work

### Phase A: measurement and correctness

First, fix label semantics, strengthen point-in-time sentiment metadata, expose truthful component health, and add fold-level uncertainty and segmentation. These changes improve trust in the existing system without changing its strategy logic.

### Phase B: component benchmarks

Next, benchmark the ranker against simple baselines, Chronos against naïve forecasts, FinBERT against keyword-only sentiment, and confluence against its arithmetic fallback. Preserve all comparisons using the same data ranges, cost assumptions, and purged time splits.

### Phase C: controlled model improvements

Only after Phase A and Phase B should Mimir test new LightGBM parameters, calibration methods, feature additions, FinBERT aggregation changes, or alternative Chronos checkpoints. Every candidate should be evaluated on untouched future folds and compared to both the incumbent model and the deterministic fallback.

### Phase D: production promotion and monitoring

Finally, add artifact hashes, versioned metadata, drift alerts, canary serving, rollback, and post-deployment outcome monitoring. Keep RL out of the primary signal path unless it clears the same evidence standard as the supervised models.

## Final assessment

> **The clearest model improvement is better target definition and validation, not a larger model.**

The current system already has several sound engineering choices: chronological splitting, purge and embargo logic, feature-order parity checks, graceful fallbacks, isotonic calibration for the ranker, and a champion-challenger promotion gate.[4] [7] [14] The main weakness is that these controls do not yet cover the entire analysis stack equally, and the available evidence is too narrow to establish that the reported ranker advantage is durable.

The safest improvement roadmap is therefore:

**Correct labels → secure point-in-time sentiment → expand walk-forward evidence → calibrate components → benchmark baselines → improve features/models → add monitoring → only then consider RL or new checkpoints.**

## References

[1]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/ranker_meta.json "Committed ranker metadata"
[2]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/scripts/extract_training_data.ts "Ranker training-data extraction and labels"
[3]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/ranker_service.py "Ranker serving and calibration"
[4]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/walk_forward_harness.py "Purged walk-forward validation harness"
[5]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/sentiment.py "FinBERT, news aggregation, keyword scoring, and caching"
[6]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/main.py "FastAPI orchestration, health, batch inference, and historical sentiment"
[7]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/src/analysis/feature_engine.ts "Canonical ranker feature contract"
[8]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/confluence_service.py "Confluence model loading and fallback"
[9]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/src/analysis/signal_generator.ts "Ranker gating, confidence blend, and risk handoff"
[10]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/train_confluence.py "Confluence model training"
[11]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/train_rl.py "PPO training environment"
[12]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/rl_agent.py "PPO serving path"
[13]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/ranker_lifecycle.py "Ranker training lifecycle"
[14]: https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/train_ranker.py "Ranker training, calibration, promotion gates, and champion-challenger logic"

*This is research and software/model analysis only, not personalized financial advice.*
