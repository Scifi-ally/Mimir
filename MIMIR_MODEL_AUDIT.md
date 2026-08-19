# Mimir Model and Inference Audit

**Repository:** `Scifi-ally/Mimir`
**Audited revision:** `9cfcb58` (`perf(ui): remove all chart animations for instant zero-latency rendering`)
**Audit date:** 19 August 2026
**Scope:** Every model-like component, estimator, pretrained checkpoint, training script, serialized artifact, inference endpoint, configuration override, and fallback path found in the repository.

## Executive conclusion

The current Mimir checkout contains **one committed learned model that is intended to be live by default**: a LightGBM binary ranker stored in `backend/ai_service/ranker_model.txt`, calibrated by `backend/ai_service/ranker_meta.json`. The deployed artifact has **32 input features, 89 serialized trees, a recommended probability threshold of 0.63, test AUC 0.723, and greenlight expectancy of 1.25% per trade**.[1]

The primary pretrained sequence model is **Amazon Chronos-Bolt-Small**, loaded from Hugging Face as `amazon/chronos-bolt-small`. It forecasts five steps by default at quantiles 0.10, 0.25, 0.50, 0.75, and 0.90. It uses `device_map="auto"` and `float16` when CUDA is available, otherwise CPU and `float32`.[2]

The news model is **ProsusAI/FinBERT**, invoked through the Hugging Face `transformers.pipeline("sentiment-analysis", model="ProsusAI/finbert")` API with no additional pipeline keyword arguments.[3] Technical ranking is **not a neural model**: `TechnicalPatternEngine` is a deterministic candlestick, momentum, volume, and technical-indicator rule engine.[4]

The repository also contains two optional model families. A PPO reinforcement-learning agent is implemented and trainable, but **no `rl_model.zip` is present in the current checkout**, so production RL inference returns a neutral `HOLD` fallback. Regime-specific LightGBM confluence models are also implemented, but **the `models/confluence/` directory contains no serialized `.pkl` artifacts**, so the live confluence endpoint currently uses its weighted arithmetic fallback unless models are trained after startup.[5]

There is **no active XGBoost implementation** in the current Python model-loading or inference paths. References to XGBoost, Kronos, Chronos-Bolt-Tiny, and Chronos-T5 occur in documentation or stale comments; the executable code uses LightGBM, `amazon/chronos-bolt-small`, and the field name `kronos` for a response object despite that object containing the Technical Pattern Engine result.[6]

## 1. Complete model inventory

| Component | Exact model or algorithm | Production status in this checkout | Loaded at startup? | Main role |
|---|---|---:|---:|---|
| Chronos | `amazon/chronos-bolt-small` via `BaseChronosPipeline` | Active when checkpoint/dependencies are available; deterministic fallback otherwise | Yes, background loader | Probabilistic close-price forecast |
| FinBERT | `ProsusAI/finbert` via Transformers sentiment pipeline | Active when Transformers can load the checkpoint; keyword-only degradation otherwise | Yes, background loader | Financial/news sentiment |
| Technical Pattern Engine | Deterministic Python rules; no learned checkpoint | Active rule engine | Yes | Candlestick and technical ranking |
| Learned ranker | LightGBM binary `Booster` loaded from `ranker_model.txt` and `ranker_meta.json` | **Artifact committed and intended to serve**; disabled if LightGBM/artifacts unavailable | Yes, background loader | Calibrated `P(target1 before stop)` |
| Confluence | Per-regime `LGBMClassifier` artifacts `confluence_<regime>.pkl` | **No artifacts currently present; weighted fallback is active** | Module constructor attempts load | Combine technical/pattern/forecast/RS/sector/sentiment scores |
| RL agent | Stable-Baselines3 PPO with `MlpPolicy` | **Not active now: `rl_model.zip` absent** | Constructor checks for artifact | Five-way action and policy confidence |
| Offline ranker optimizer | Temporary LightGBM boosters | Offline only; saves no production model | No | Threshold/Kelly sensitivity analysis |

The production FastAPI lifespan loads FinBERT, the Technical Pattern Engine, Chronos, and the learned ranker in a background thread. This allows the HTTP server to bind before heavyweight model loading completes.[7] The confluence service is instantiated when imported and scans its model directory, while the RL service checks for its artifact during module construction.[5]

## 2. Chronos-Bolt-Small: exact configuration and inference

### 2.1 Checkpoint and hardware parameters

The executable checkpoint identifier is exactly **`amazon/chronos-bolt-small`**. The loader calls `BaseChronosPipeline.from_pretrained` with the following explicit arguments:[2]

| Parameter | Exact value or expression | Meaning |
|---|---|---|
| Pretrained identifier | `"amazon/chronos-bolt-small"` | Hugging Face checkpoint |
| `device_map` | `"auto" if torch.cuda.is_available() else "cpu"` | Automatic CUDA placement when available; CPU otherwise |
| `torch_dtype` | `torch.float16` on CUDA, `torch.float32` on CPU | Half precision on GPU; single precision on CPU |
| Smoke test | `_infer_with_model([100.0, 100.5, 100.9, 101.2, 101.7], 3)` | Verifies the loaded pipeline before marking it healthy |
| Singleton behavior | `_model_loaded` / `_load_error` latch | Repeated loads are skipped after success or failure |

The code does not explicitly set a Transformers `device`, batch size, generation temperature, top-p, seed, or sampling count. Chronos inference is performed under `torch.inference_mode()`.

### 2.2 Forecast call parameters

The model call is `predict_quantiles(context, prediction_length=steps, quantile_levels=QUANTILE_LEVELS)`. The exact constants are:[2]

| Parameter | Exact value |
|---|---:|
| Default forecast horizon | `FORECAST_STEPS = 5` |
| Quantile levels | `[0.1, 0.25, 0.5, 0.75, 0.9]` |
| Quantile output keys | `q10`, `q25`, `q50`, `q75`, `q90` |
| Input tensor dtype | `torch.float32` |
| Tensor shape, single series | `(1, context_length)` after `unsqueeze(0)` |
| Tensor shape, batch | One 1-D tensor per series; output expected as `(batch, steps, quantiles)` |
| Public `steps` clamp | `max(1, min(steps, 30))` |
| Single endpoint default | `steps=5` |
| Batch endpoint behavior | Uses default five steps; it calls `infer_batch` without overriding `steps` |
| API minimum input | Two closes for the single Chronos endpoint; at least 20 OHLCV rows for a batch candidate |

The batch endpoint extracts close prices from `cand.closes` when supplied, otherwise from OHLCV column index 3, and performs one batched Chronos call for all candidates. A process-wide async semaphore of size one protects GPU inference.[8]

### 2.3 Input preprocessing and postprocessing

Before inference, the service requires a one-dimensional close series of at least two values. For series with at least five observations, it computes the standard deviation of the most recent up-to-20 simple returns. If that volatility exceeds **0.02**, it applies EMA-3 smoothing with `alpha = 2/(3+1) = 0.5` to the model input only. Forecast levels are subsequently rebased to the actual last close.[2]

The trend label uses a forecast return threshold of **+0.3% for `bullish`** and **−0.3% for `bearish`**; values in between are `neutral`. The returned percentage is the final median forecast relative to the actual last close.[2]

### 2.4 Chronos fallback model

If the checkpoint is unavailable, model inference raises, a batch forward pass fails, or an individual series is invalid, the service falls back to a deterministic momentum/mean-reversion forecaster. Its exact parameters are:[2]

| Fallback parameter | Exact behavior |
|---|---|
| Short momentum window | `min(5, n)` closes |
| Long mean window | `min(20, n)` closes |
| Mean-reversion pull | `(long_mean - last) / last * 0.05` |
| Momentum decay | `0.7 ** step` |
| Recent volatility | Standard deviation of returns over the last up-to-20 closes when at least five points exist |
| Volatility floor | `0.001` |
| Quantile spread | `vol * sqrt(step)` |
| Quantile construction | `price * (1 + z * spread)` using an internal approximate normal inverse CDF |
| Forecast source | `"fallback"` |
| Invalid input result | Empty forecast, neutral trend, zero return, source `"error"` |

This fallback is not a learned model and does not sample. It is the reason a synthetic Chronos result can still be considered a usable AI-service result by the Node client, provided the Technical Pattern Engine itself did not fail.[9]

## 3. FinBERT: exact configuration and scoring

### 3.1 Model initialization

FinBERT is loaded once through the exact call `pipeline("sentiment-analysis", model="ProsusAI/finbert")`. No tokenizer, device, truncation, maximum sequence length, temperature, sampling, or batch-size keyword is explicitly supplied to the pipeline constructor.[3]

The pipeline receives up to the first **15 RSS headlines** in one call. Results are converted to signed scores as follows:[3]

| FinBERT label | Numeric contribution |
|---|---:|
| `positive` | `+score` |
| `negative` | `-score` |
| Any other label | `0.0` |
| Pipeline unavailable or runtime exception | `0.0` for each headline, then keyword-only geopolitical scoring where applicable |

### 3.2 Recency weighting and keyword blending

Each headline is weighted by exponential decay with a **six-hour half-life**: `2 ** (-hours_ago / 6.0)`. If geopolitical amplification is enabled and a keyword score is present, the combined headline score is `0.6 * FinBERT + 0.4 * geopolitical_score`. If FinBERT is unavailable or fails at runtime, the geopolitical keyword score carries full weight. Without a geopolitical match, the FinBERT score is used unchanged.[3]

The market-wide process fetches Moneycontrol, Economic Times, LiveMint, Yahoo World, India-politics, and RBI-policy feeds. It computes market, world, and India-political scores concurrently in worker threads. Symbol-specific headlines come from Yahoo Finance RSS.[3]

### 3.3 Composite sentiment parameters

The final sentiment composite is exactly:[3]

`0.30 * symbol_specific_score + 0.25 * market_wide_score + 0.25 * india_political_score + 0.20 * world_score`

Results are rounded to four decimals. The normal cache TTL is **300 seconds**. Results computed while FinBERT inference is failing use a **20-second** effective TTL. Pipeline calls are serialized by a process-wide lock because the source explicitly guards against concurrent fast-tokenizer errors.[3]

The live Node client converts Python's `[-1, +1]` sentiment scale to the consumer's `[0, 100]` scale using `((score + 1) * 50)` and clamps the result.[9]

## 4. Technical Pattern Engine: deterministic, not learned

The Technical Pattern Engine initializes no checkpoint and imports no model weights. `load_model()` merely marks the rule engine as loaded and healthy. Its `_infer_with_model` method is a pass-through to `_infer_engine`, which evaluates OHLCV data and feature fields using deterministic formulas.[4]

The engine detects doji, hammer, inverted hammer, shooting star, hanging man, bullish/bearish engulfing, morning/evening star, three white soldiers, and three black crows. Pattern biases and confidence weights are hard-coded. Examples include bullish engulfing `+0.25 / +0.20`, bearish engulfing `−0.25 / +0.20`, morning star `+0.30 / +0.22`, and three black crows `−0.35 / +0.25`.[4]

Other exact parameters include a recent-close momentum multiplier of **50**, volume-ratio cap of **5.0×**, volume impact of **0.15 per excess ratio unit**, ADX window **14**, strong-trend threshold **25**, choppy threshold **20**, Stochastic RSI window **14** with smoothing **3/3**, ATR window **14**, high-volatility threshold **5% ATR/close**, and a final sigmoid `1/(1 + exp(-5*bias))`. Confidence is clamped to `[0.0, 0.85]`.[4]

This engine returns the `bullish_probability` used as the main technical pattern input to the composite score. The response field is named `kronos` in the Python/Node response object, but it contains this Technical Pattern Engine result; it is not a Kronos model invocation.[8]

## 5. Learned LightGBM ranker

### 5.1 Actual deployed artifact

The committed `ranker_model.txt` is a LightGBM binary-sigmoid Booster with `max_feature_idx=31`, meaning 32 columns indexed from zero, and **89 serialized trees**. Its header lists the same 32 feature names as the metadata file.[1]

The committed metadata reports the following live model values:[1]

| Metadata field | Exact value |
|---|---:|
| `recommended_threshold` | `0.63` |
| `test_auc` | `0.723` |
| Legacy `val_auc` | `0.723` |
| `test_brier` | `0.2335` |
| Take-all expectancy | `0.62%` per trade |
| Greenlight expectancy | `1.25%` per trade |
| Greenlight count | `28` |
| Test count | `100` |
| Trained at | `2026-07-27T07:32:18Z` |

The metadata also stores the isotonic calibration knots and feature importances. The calibration map is applied with piecewise-linear interpolation and then clipped to `[0.0, 1.0]` at serving time.[1]

### 5.2 Exact feature order

The ranker consumes exactly these 32 ordered numeric fields:[10]

| Index | Feature | Index | Feature |
|---:|---|---:|---|
| 0 | `rsi14` | 16 | `momentumScore` |
| 1 | `atr14` | 17 | `trendScore` |
| 2 | `atrPct` | 18 | `volatilityScore` |
| 3 | `adx14` | 19 | `riskRewardScore` |
| 4 | `volumeRatio` | 20 | `priceRoc5` |
| 5 | `vwapDistance` | 21 | `priceRoc10` |
| 6 | `ema20Dist` | 22 | `priceRoc20` |
| 7 | `ema50Dist` | 23 | `bodyRatio` |
| 8 | `ema200Dist` | 24 | `upperWickRatio` |
| 9 | `emaAlignment` | 25 | `lowerWickRatio` |
| 10 | `trendConsistency` | 26 | `closeLocation` |
| 11 | `rsVsNifty60d` | 27 | `realizedVol5` |
| 12 | `rsVsSector60d` | 28 | `realizedVol20` |
| 13 | `pocDistancePct` | 29 | `volOfVol` |
| 14 | `bbWidthPct` | 30 | `cprWidthPct` |
| 15 | `vcpContraction` | 31 | `fiiDiiNetFlowLag` |

The TypeScript feature engine explicitly excludes live-only `regimeScore`, `sectorStrength`, and `marketStrength` from this contract. It refuses to project `rankerIncomplete` vectors, maps non-finite values to zero, and constructs the array in this exact order.[10]

### 5.3 Exact training configuration

The production ranker trainer uses the native LightGBM Python API. Its explicit parameter dictionary is:[11]

| LightGBM parameter | Exact value |
|---|---:|
| `objective` | `"binary"` |
| `metric` | `["auc", "binary_logloss"]` |
| `learning_rate` | `0.03` |
| `num_leaves` | `31` |
| `max_depth` | `6` |
| `min_data_in_leaf` | `40` |
| `feature_fraction` | `0.8` |
| `bagging_fraction` | `0.8` |
| `bagging_freq` | `5` |
| `lambda_l1` | `0.5` |
| `lambda_l2` | `1.0` |
| `scale_pos_weight` | `(1 - positive_rate) / positive_rate`, with positive rate floored at `1e-6` |
| `verbose` | `-1` |
| `seed` | `42` |
| `num_boost_round` | `600` maximum |
| Validation set | Calibration slice only, named `calib` |
| Early stopping | `50` rounds, `verbose=False` |
| Logging callback | `lgb.log_evaluation(0)` |
| Saved iteration | `booster.best_iteration` |

Parameters such as `num_threads`, `bagging_seed`, `feature_fraction_seed`, `min_gain_to_split`, and `max_bin` are **not explicitly set by Mimir** and therefore remain LightGBM/library defaults. The 89-tree committed artifact is the result of early stopping and saving only through `best_iteration`; it is not a 600-tree production model despite the 600-round ceiling.[1] [11]

### 5.4 Training split, calibration, and promotion gates

Rows are sorted chronologically. The default split is **60% training, 20% calibration, and the remaining rows as test**, with complete timestamp groups kept together. Training and calibration rows whose `resolutionTs` overlaps the next window are purged, and the default embargo is **24 hours**.[11]

Isotonic regression uses `sklearn.isotonic.IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)`. The trainer samples **50 evenly spaced calibration knots** between the minimum and maximum raw calibration score. If scikit-learn fails, it falls back to equal-frequency bins, between 4 and 20 bins, with cumulative-maximum monotonicity.[11]

When `--threshold auto` is used, the trainer evaluates thresholds from **0.45 through 0.75 in increments of 0.01** on the calibration slice, requiring at least `max(20, len(calibration)//20)` selected trades. It then freezes the chosen threshold and evaluates it on the untouched test slice. The model ships only if test AUC is at least **0.53**, greenlight expectancy is positive, greenlight expectancy exceeds take-all expectancy, and at least one trade is greenlit. An existing champion must be beaten by `max(0.02 percentage points, 10% of the absolute champion expectancy)` unless `--force` is supplied.[11]

### 5.5 Exact serving behavior

The service reads `RANKER_MODEL_PATH` and `RANKER_META_PATH` when set; otherwise it uses `backend/ai_service/ranker_model.txt` and `backend/ai_service/ranker_meta.json`. It constructs `lgb.Booster(model_file=model_path)`, reads metadata JSON, and uses the stored feature keys and isotonic arrays.[12]

For a batch, rows with a width other than the metadata feature count return `None` rather than being padded. Numeric non-finite values inside a correctly sized row become zero. LightGBM receives a `float64` matrix. The raw predictions are isotonic-calibrated, clipped to `[0, 1]`, rounded to four decimals, and returned in input order. Any exception returns `None` for every row in the batch.[12]

The live signal generator applies an additional conservative floor. With a loaded ranker, the effective gate is `max(0.58, ranker_threshold)`, so the committed artifact's **0.63** threshold remains 0.63. Signals below that probability are rejected. Survivors use a 70/30 confidence blend: `0.70 * (win_probability * 100) + 0.30 * legacy_confidence`. The calibrated probability is also passed into risk assessment for quarter-Kelly sizing.[13]

## 6. Regime-gated confluence LightGBM

### 6.1 Trainer configuration

The optional confluence trainer creates one model per unique regime when that regime has at least 50 rows. Its six features, in order, are `tech_score`, `pattern_score`, `chronos_score`, `rs_score`, `sector_score`, and `sentiment_score`. Every feature has a positive monotonic constraint.[14]

| Parameter | Exact value |
|---|---:|
| Estimator | `lightgbm.LGBMClassifier` |
| `max_depth` | `3` |
| `num_leaves` | `7` |
| `learning_rate` | `0.05` |
| `n_estimators` | `50` |
| `monotone_constraints` | `[1, 1, 1, 1, 1, 1]` |
| `min_child_samples` | `5` |
| `verbose` | `-1` |
| Validation | Purged K-fold, `k=3`, `embargo_pct=0.05` |
| Persistence | `joblib.dump` to `models/confluence/confluence_<regime>.pkl` |

The service loads every matching `.pkl` file in `backend/ai_service/models/confluence`. For a loaded regime model it calls `predict_proba(x)[0, 1]` and returns `round(prob * 100, 2)`.[14]

### 6.2 Current runtime status and fallback

The checked-out repository contains **zero confluence `.pkl` files**, so no regime model is currently loaded. The fallback score is a weighted arithmetic blend with weights **0.35 technical, 0.20 pattern, 0.15 Chronos, 0.10 relative strength, 0.10 sector, and 0.10 sentiment**, using a default feature value of 50 for missing fields and clamping the result to `[0, 100]`.[5]

The TypeScript signal generator calls the confluence endpoint only when the AI service has contributed a real candidate result. If the endpoint reports fallback, it uses the native TypeScript confidence formula instead.[13]

## 7. PPO reinforcement-learning agent

### 7.1 Training environment and constructor

The RL script uses Stable-Baselines3 PPO with `MlpPolicy`. The environment has a five-action discrete space and a seven-element normalized observation vector:[15]

| Item | Exact value |
|---|---|
| Algorithm | `PPO` |
| Policy | `"MlpPolicy"` |
| Constructor keyword | `verbose=1` |
| Actions | 0 Strong Sell, 1 Sell, 2 Hold, 3 Buy, 4 Strong Buy |
| Observation | Close, Volume, RSI, MACD, VIX, FII/DII net, PCR |
| Observation shape | `(7,)` |
| Observation dtype | `np.float32` |
| Episode length | `252`, clamped to `len(df)-1` |
| Training timesteps | `20_000` |
| Saved path | `backend/ai_service/rl_model.zip` by default |
| Existing model behavior | `PPO.load(model_path, env=env)` for fine-tuning |
| New model behavior | `PPO("MlpPolicy", env, verbose=1)` |

The training data is fetched from Yahoo Finance from **2018-01-01** for `RELIANCE.NS`, `TCS.NS`, `HDFCBANK.NS`, `INFY.NS`, and `ICICIBANK.NS`, plus `^INDIAVIX`. RSI uses `window=14`; MACD uses the `ta.trend.MACD` defaults; PCR is hard-coded to **1.0** because historical options data is unavailable. FII/DII data is shifted by one row to avoid using post-market information for the same action.[15]

The reward is the next same-symbol close return multiplied by an action multiplier: `{-1.0, -0.5, 0.0, 0.5, 1.0}`. Cross-symbol seam returns are zeroed.[15]

### 7.2 Serving parameters

The serving path loads `RL_MODEL_PATH` when set, otherwise `backend/ai_service/rl_model.zip`. It reconstructs RSI(14) and MACD-diff with the same `ta` calls if absent, then normalizes the state as follows:[16]

| State component | Normalization |
|---|---:|
| Close | `close / 10000.0` |
| Volume | `volume / 1000000.0` |
| RSI | `rsi / 100.0` |
| MACD | `macd / 100.0` |
| VIX | `vix / 50.0` |
| FII/DII net | `fii / 10000.0` |
| PCR | `1.0 / 3.0`, always; live PCR is intentionally ignored |

Inference calls `self.model.predict(state, deterministic=True)`. The selected action maps to score adjustments `{-0.5, -0.25, 0.0, 0.25, 0.5}`. Confidence is the PPO policy's actual probability mass on the selected action, obtained through the policy distribution; if that internal lookup fails, it returns neutral confidence `0.5`.[16]

### 7.3 Current runtime status

There is no `backend/ai_service/rl_model.zip` in the checked-out repository. Therefore the constructor leaves the RL service unloaded, and `/api/v1/predict_rl` returns `HOLD`, confidence `0.0`, score adjustment `0.0`, `isFallback=true`, and `source="no_model"` until training creates an artifact.[5] [16]

## 8. Offline and non-production model code

`optimize_risk.py` trains temporary LightGBM boosters for threshold and Kelly-multiplier analysis. It is not imported by the FastAPI service and does not save a model. Its temporary parameters are `objective="binary"`, `metric="binary_logloss"`, `learning_rate=0.03`, `num_leaves=31`, dynamic `scale_pos_weight`, `verbose=-1`, and fold-dependent seeds (`42 + fold_idx` for train/validation and `99 + fold_idx` for holdout), with 600 maximum rounds and 50-round early stopping.[17]

The offline optimizer searches thresholds from **0.45 to 0.75** in **31** points and Kelly multipliers from **0.1 to 1.0** in **19** points, clips risk percentage to `[0, 2.0]`, and reports a Sharpe-like mean-over-standard-deviation score. None of those temporary boosters is loaded in production.[17]

The older `walk_forward.py` utility is a splitter only. The active richer harness is `walk_forward_harness.py`, which uses five-day label horizon, one-day embargo, 30-day test windows, 180-day minimum training windows, structural breaks at 2024-11-20 and 2025-09-01, optional rolling windows, and LightGBM seeds `42 + fold_idx`.[18]

## 9. End-to-end live request path

The Node backend first calls `/health`. If the service is healthy or degraded but reachable, it sends `/inference/batch`; if it is unavailable, times out, or the circuit breaker is open, the backend runs its native math fallback. The default service URL is `http://localhost:8001` locally and `http://ai-service:8001` in Docker. The default inference timeout is **30,000 ms + 500 ms per candidate**, capped at **120,000 ms**. The circuit breaker opens after five failures and uses a 15-second cooldown.[9]

For a normal batch, the Python service executes the following sequence:[8]

1. It validates one to 200 candidates, each with at least 20 OHLCV rows.
2. It derives close-price series and runs one batched Chronos forecast under the GPU semaphore.
3. It runs one batched LightGBM ranker prediction over `features["ranker_features"]`.
4. It processes each candidate with the Technical Pattern Engine and sentiment analysis under a CPU semaphore of four.
5. It converts Technical Pattern Engine output, Chronos forecast, confidence, sentiment, order-flow, and macro-divergence fields into the 0–100 composite score.
6. It returns candidate scores plus batch-level `ranker_loaded` and `ranker_threshold` metadata.

The composite score before later signal gates is:

`technical_probability * 50 + sigmoid(3 * forecast_return_pct) * 30 + technical_confidence * 15 + sentiment_composite * 5`

A world sentiment below **−0.5** subtracts 15 points. A nonzero order-flow imbalance adds `ofi_ratio * 5`, and a nonzero macro-divergence penalty/boost is added directly. The final score is clamped to `[0, 100]`.[8]

The TypeScript signal generator then attempts the learned-ranker gate first, applies the 0.58 floor, blends surviving ranker probabilities at 70/30 with the existing confidence, applies minimum-confidence, multi-timeframe, regime-direction, earnings, and risk gates, and passes the calibrated probability into risk sizing.[13]

## 10. Configuration and deployment findings

The Python service supports `RANKER_MODEL_PATH`, `RANKER_META_PATH`, and `RL_MODEL_PATH` overrides, but the committed Docker Compose configuration does **not** pass any of these variables. Therefore the default artifact locations are used in the standard Compose deployment. Compose passes `AI_CORS_ORIGINS`, `DATABASE_URL`, and the required `AI_SERVICE_TOKEN` to the AI service, and configures the backend to call `http://ai-service:8001`.[5] [19]

The Compose file assigns a two-gigabyte memory limit to the AI service and does not declare a Docker GPU reservation. Consequently, the code is capable of using CUDA when the runtime exposes it, but standard Compose configuration alone does not guarantee GPU access. On CPU, Chronos selects CPU placement and `float32` according to its own loader logic.[2] [19]

## 11. Important inconsistencies and operational risks

| Finding | Evidence | Consequence |
|---|---|---|
| Chronos naming drift | Main-module comments mention Chronos-Bolt-Tiny and the app description mentions Kronos, while the executable loader uses `amazon/chronos-bolt-small` | Monitoring or documentation can report the wrong model name unless the source code is corrected |
| `kronos` response field | `CandidateScore` uses `kronos` although the value is from `technical_pattern_engine` | API consumers may incorrectly believe a separate Kronos model exists |
| XGBoost references | README and prompt text mention XGBoost, but executable model construction found in the current checkout is LightGBM | Do not infer an XGBoost model is deployed from documentation alone |
| Confluence artifacts absent | Loader finds zero `.pkl` files in the current checkout | Confluence is currently the weighted fallback, not a trained regime model |
| RL artifact absent | `rl_model.zip` is absent | RL endpoint currently returns `source="no_model"` and neutral HOLD |
| Ranker artifact committed | `ranker_model.txt` and `ranker_meta.json` are present and mutually aligned on 32 features | Learned ranker is the only serialized learned artifact currently positioned to serve immediately |
| Threshold mismatch risk | Python metadata threshold is 0.63, while TypeScript applies `max(0.58, threshold)` | Effective current threshold is 0.63; changing the metadata can never lower it below 0.58 |
| Optional dependency degradation | LightGBM and Transformers are guarded; Chronos catches load/inference errors | A nominally healthy process can run in degraded deterministic mode, so health/status must be checked rather than inferred from process availability |

## Final answer in one sentence

**Mimir currently uses `amazon/chronos-bolt-small`, `ProsusAI/finbert`, a deterministic Technical Pattern Engine, and a committed 32-feature LightGBM ranker in its main path; PPO RL and regime-specific confluence LightGBMs are implemented but inactive in this checkout because their serialized artifacts are absent, while the exact parameters and fallbacks are documented above.**

## References

[1]: [Committed LightGBM ranker artifact and metadata](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/ranker_model.txt) and [ranker metadata](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/ranker_meta.json)
[2]: [Chronos service implementation](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/chronos_service.py)
[3]: [FinBERT sentiment implementation](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/sentiment.py)
[4]: [Technical Pattern Engine implementation](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/technical_pattern_engine.py)
[5]: [Ranker, confluence, and RL model loaders](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/ranker_service.py), [confluence service](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/confluence_service.py), and [RL agent service](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/rl_agent.py)
[6]: [Repository model references and architecture documentation](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/README.md) and [AI-service entrypoint comments/description](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/main.py)
[7]: [AI-service lifespan and startup loading](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/main.py)
[8]: [AI-service request schemas and production inference orchestration](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/main.py)
[9]: [Node AI client, transport, timeouts, circuit breaker, and fallbacks](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/src/analysis/ai_client.ts)
[10]: [Canonical TypeScript ranker feature contract and feature construction](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/src/analysis/feature_engine.ts)
[11]: [Production ranker trainer](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/train_ranker.py)
[12]: [Production ranker serving implementation](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/ranker_service.py)
[13]: [Live signal gating, confidence blending, and risk-sizing handoff](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/src/analysis/signal_generator.ts)
[14]: [Confluence trainer and service](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/train_confluence.py) and [confluence serving implementation](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/confluence_service.py)
[15]: [PPO training environment and training script](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/train_rl.py)
[16]: [PPO serving implementation](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/models/rl_agent.py)
[17]: [Offline risk optimizer](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/optimize_risk.py)
[18]: [Walk-forward validation harness](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/backend/ai_service/walk_forward_harness.py)
[19]: [Docker Compose production wiring](https://github.com/Scifi-ally/Mimir/blob/9cfcb58/docker-compose.yml)
