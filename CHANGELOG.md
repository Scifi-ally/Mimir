# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Batched System-1 triage**: `/inference/batch` now groups candidates by the engine they
  require and issues a single true-batch inference per engine, instead of one call per
  candidate. Laya runs one ModernBERT forward pass over all prompts; Jev fans every cache
  miss out concurrently over its pooled connection pool. Per-candidate `preferred_engine`
  is still honoured inside a mixed batch.
- **Jev transport hardening**: pooled keep-alive HTTP client, short-TTL decision cache
  keyed on a canonical state digest, consecutive-failure circuit breaker with cooldown,
  and an adaptive timeout. New knobs: `TYPESAFE_TIMEOUT_MS`, `JEV_CACHE_TTL_S`,
  `JEV_CACHE_MAX`, `JEV_BREAKER_FAILURES`, `JEV_BREAKER_COOLDOWN_S`, `JEV_MAX_WORKERS`.
- **`.env` loading for the AI microservice** (`backend/ai_service/env_loader.py`): a
  dependency-free dotenv loader matching the Node side's precedence (`.env.local` over
  `.env`, real environment variables always win). `MIMIR_SKIP_DOTENV=1` opts out and is
  set by the test suite.
- **`.gitattributes`**: model artifacts are marked `-text` so line-ending conversion can
  never corrupt them again.

### Fixed
- **NaN produced a perfect score.** Python's `min`/`max` return their *first* argument unless
  the second is strictly smaller, and every comparison against NaN is `False` — so
  `max(0, min(100, nan))` evaluates to **100**. A single NaN anywhere upstream (a missing
  close, a null→NaN column mapping, a Postgres `double precision` NaN) handed a candidate
  with corrupt data the highest possible composite score, and `_trend_bias` returned the
  `+0.3` clamp ceiling (maximum bullish). Added `models/numeric_utils.py`
  (`sanitize_float` / `finite_clamp` / `safe_div`) and applied it across the composite
  score, technical pattern engine, confluence scoring, and the RL observation vector.
- **Consensus sized UP when an engine saw risk.** `resolve_decision` combined the two
  position-size multipliers with `max()`, but the multipliers are opposite-polarity
  signals: `1.25` is returned only for *clean* conditions, `0.85` only for *elevated
  risk*. One optimistic engine therefore overruled the other's risk downsize, and the
  plain-mean probability pooling diluted a `0.60` stop-hunt reading to `0.375` — right on
  the `0.35` routing threshold. Pooling is now fail-safe (`min` for multiplier/quality,
  `max` for risk).
- **System-1 sizing overrode hard risk-engine caps.** `signal_generator` multiplied
  `riskAssessment.positionSize` — already halved for macro event risk and cut to fit
  `maxDeployedCapitalPct` — by up to `1.25x`, re-inflating past the cap just enforced
  (`Math.max(1, …)` could even grow a cap-constrained size of 0 or 1). System-1 may now
  only veto or downscale.
- **Intraday subsystem was dead code.** A 1% stop against a 1.5% target yields RR 1.5, but
  the risk engine enforces ≥1.8 — so *every* intraday signal was rejected before it could
  be emitted. Target geometry now clears the configured minimum and RR is derived from
  the actual levels. Rejections also set `signalGenerated`, so a rejected setup stops
  being re-detected and re-run every 10–500 ms for the rest of the session.
- **6-column OHLCV silently disabled all TA features.** A `[timestamp, O, H, L, C, V]`
  payload — the documented RL contract format — passed the `>= 4` column guard, failed
  inside the TA block, and the swallowed exception disabled the ADX chop dampener and
  ATR confidence reduction for every candidate it touched. Column normalization is now
  explicit.
- **Native surrogate impersonated real models.** The TypeScript fallback was stamped
  `model_id: "convaiinnovations/laya"` / `"jev-1"`, attributing hand-written heuristic
  output to a calibrated neural model in every metric keyed on `model_id`. It now reports
  `native_ts_deterministic_surrogate`.
- **Malformed OHLCV could kill a whole scan.** The native-fallback loop sat outside any
  `try/catch`, so one `null` row (destructuring `TypeError`) or non-numeric field (`NaN`)
  rejected `batchInference()` and discarded every other candidate's results. Now isolated
  per candidate, with non-finite series rejected.
- **Ragged OHLCV rows raised `IndexError` outside any handler** in the batch pre-pass,
  500-ing the entire request and discarding all other candidates' work.
- **One candidate could 500 an entire batch** via `asyncio.gather` re-raising the first
  exception in the phase-2 per-candidate retry. Now uses `return_exceptions=True`.
- **Worker pools could hang forever.** `ScanWorkerPool` had no per-task timeout, so a
  wedged worker left the promise unsettled *and* permanently consumed a concurrency slot;
  `enqueue` after `shutdown()` never settled in either pool. The crash-loop respawn timer
  was untracked and could spawn a Worker after shutdown, leaking a thread per
  restart cycle. All three fixed.
- **`scanMarket` concurrency limiter could go negative.** The abort path decremented
  `active` and then `return`ed, so `finally` decremented it *again* — admitting more than
  the configured limit of concurrent `scanStock` calls.
- **Non-atomic ranker reload.** Globals were assigned one at a time while `predict_batch`
  read them unlocked, so a request could score the old booster against the new isotonic
  calibration (a miscalibrated `P(win)`, which is a hard trade gate) or the new booster
  against stale feature keys (LightGBM raises → ranker silently disabled for the batch).
  Now published as a single snapshot.
- **Confluence service race + NaN.** `self.models` was cleared and refilled in place, so a
  concurrent reader could `KeyError` into a confident-looking 50.0 for an already-scored
  regime; a NaN feature produced a score of 100.0, above the legitimate maximum of 61. Now
  an atomic swap with a reload throttle, and NaN-safe scoring.
- **RL endpoint could return `STRONG_SELL` with `confidence: NaN`** and crash response
  serialization (`bool(nan)` is `True`, so the `if x else default` guards were ineffective).
- **`.env` parser left literal quotes** in a quoted value with a trailing comment
  (`KEY="abc"` → `"abc"`), producing `Authorization: Bearer "abc"` → HTTP 401 → the Jev
  circuit breaker opening permanently. Also: the search walked into the user's home
  directory, silently applying a `~/.env` of credentials to a live trading service. Both
  fixed; the search now stops at the repository root.
- **Confluence retrain reported success unconditionally**, used a relative script path
  with no `cwd` (so it silently no-op'd), and had no in-flight guard (N POSTs → N
  training subprocesses).
- **Unbounded caches:** `aiCache` (~450 forecast numbers per symbol), the daily/hourly
  candle caches (a new key per instrument per trading day), and `_sentiment_cache` (one
  permanent entry per symbol ever scored) are now size-capped with expiry sweeps.

- **CRLF-corrupted ranker artifact**: LightGBM's text model parser rejects CRLF and
  **aborts the whole process** (`STATUS_STACK_BUFFER_OVERRUN`) rather than raising a
  catchable exception, so a Windows `core.autocrlf=true` checkout prevented the AI service
  from starting at all. The ranker now normalizes line endings before the C++ loader is
  invoked. The shipped model loads 89 trees / 32 features at val AUC 0.723.
- **Jev Noul probabilities were fabricated**: `p_execution_success`, `p_stop_hunt_risk`,
  and `p_adverse_regime_shift` were derived from the verdict label via three hardcoded
  constants, so `LIMIT_PULLBACK` routing and dynamic sizing acted on numbers carrying no
  market information. They are now requested from the API, and fall back to the locally
  RLCD-calibrated values when omitted.
- **Jev response validation**: a `verdict` that is missing, blank, non-string, or outside
  the contract is now rejected and routed to the local surrogate. Contradictory
  `(REJECT, EXECUTE_IMMEDIATELY)` pairs are repaired so an entry cannot slip past the
  router's REJECT filter.
- **Position sizing ignored risk**: `position_size_multiplier` required only
  `confidence >= 0.80`. It now also requires clean execution odds, and scales *down* to
  0.85x on elevated stop-hunt or regime-collapse risk. Applied consistently across the
  Python and TypeScript tiers.
- **Misleading System-1 health**: a Jev cloud-tier circuit breaker no longer folds into a
  top-level `healthy: false`, since tiers 1/3/4 still answer. Exposed as
  `jev_cloud_degraded`.
- **Non-hermetic tests**: two System-1 tests asserted the offline fallback but could reach
  a live service on `:8001`, so the suite passed or failed depending on whether a dev
  server was running. They now pin `AI_SERVICE_URL` to an unroutable address.

## [1.1.0] - 2026-07-23

### Added
- **Custom Watchlists**: Seamless command-palette integration for dynamic on-the-fly manual symbol monitoring.
- **Dynamic Island UI**: Seamless status updates, toast notifications, and event streams decoupled from the primary charting interface.
- **Developer Experience**: Standardized `Makefile` and Dependabot workflows for automated dependency management.

### Changed
- **Adaptive Layout Modes**: Flexible and customizable UI layouts to focus purely on signals, charting, or complete terminal views.
- **Pure Digital Scanner**: Visually stunning digital display during overnight scan jobs.
- **Performance optimizations**: Brutal backend architectural cleanup resulting in zero circular dependencies and leaner code.

### Fixed
- **Mobile Responsiveness**: Fixed TopBar horizontal scroll cut-off due to justify alignment bugs on Safari/Chrome.
- **View Transition Engine**: Hardened the dark/light mode animation by scaling viewport coordinates to percentages, bypassing mobile UI layout scaling offsets.
- **PWA Service Worker**: Addressed aggressive caching issues to ensure instantaneous background app updates.

## [1.0.0] - 2026-07-12

### Added
- **Intelligent Load Balancing**: Deterministic round-robin load balancing for Upstox V2/V3 APIs.
- **Custom Screener Engine**: Interactive rule builder and background scanning worker pool.
- **Advanced UI Dashboard**: TradingView lightweight-charts with EMA, VWAP, Support/Resistance zones, and price projection overlays.
- **Paper Trading Engine**: Test quantitative strategies in live market conditions.
- **Divergence Engine**: Automated detection of RSI and MACD divergences against price action.
- **Institutional Order Flow Tracking**: Deep evaluation of institutional accumulation and distribution phases.

### Changed
- **Documentation**: Revamped README and CONTRIBUTING guidelines to an industrial standard.
- **Backend Architecture**: Decoupled monolithic routes, optimized frontend websocket store, and stabilized database pools.
- **CI/CD**: Optimized Docker workflows and GitHub Actions pipelines.

### Fixed
- **Security**: Patched authentication bypasses, secured websocket payloads, and enforced rate limits.
- **Data Integrity**: Used decimal.js for financial math in paper engine to avoid precision drift.
- **Bug Fixes**: Resolved AI target zooming out bug and Python pydantic validation errors.
