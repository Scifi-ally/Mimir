# MIMIR council audit — 2026-10-02

Sol coordinated three lower-cost Luna implementation agents: market data and signals,
quantitative validation, and backend reliability. Sol reviewed the changes and checked
browser transport and the desktop shell. No UI layout or styling was changed, and no
broker order was submitted during this work.

## Implemented corrections

- Source integrity: actual FII/DII report dates, strict parsing, stale-source clearing,
  independent VIX updates, aligned benchmark/sector history and equity-bar validation.
- Quantitative admission: calibrated probability separated from heuristic scores;
  missing inputs and unvalidated artifacts abstain; intraday and cash-short signals
  cannot borrow evidence from a daily long-only model.
- Forecast honesty: unavailable Chronos models return empty forecasts and null return;
  synthetic quantiles no longer supply a directional score. Legacy LLM price-prediction
  source labels contribute neutrally; the current pattern engine uses numerical rules.
- Research: shared conservative fills and realistic delivery costs; purged walk-forward
  splits; frozen calibration thresholds; identical training/evaluation model settings;
  artifact digest and strategy-scope verification; coherent inference during reload.
- Execution reliability: durable duplicate-order guards, explicit uncertain outcomes,
  position/margin reservation while reconciliation is required, and protective-stop
  request/cancellation checks. Tests use mocks, not a connected broker.
  GTT contracts were checked against Upstox's official
  [placement](https://upstox.com/developer/api-documentation/place-gtt-order/) and
  [cancellation](https://upstox.com/developer/api-documentation/cancel-gtt-order/) documentation.
  Entry-fill checks use the official
  [order-details contract](https://upstox.com/developer/api-documentation/get-order-details/).
- Browser/runtime correctness: invalid/out-of-order quotes rejected, stale observations
  cannot regain freshness, REST cannot overwrite a newer quote, nested tick envelopes
  decoded consistently, scanner failures cannot be overwritten by queued progress, and
  LIVE disarm messages are classified correctly.
- Desktop shutdown: terminate the owned managed-service process tree on Windows so npm
  wrappers do not leave child services running.
- Rate limiting: invalid limits fall back to a valid cap; rejected requests do not
  extend the admission window. An isolated real Redis test admitted exactly 25 of 300
  concurrent requests and recovered after the window. Redis MULTI was already atomic.

## Evidence

Final software checks: 200 backend tests, 51 frontend tests and 101 Python tests
passed; two Python tests were skipped. Backend typecheck, backend/frontend production
builds, desktop Rust compilation and desktop doctor passed. Focused LIVE regressions
verify that an acknowledgment does not close a position, realize P&L or release
margin, and that an unfilled entry cannot create a protective GTT. All broker responses
in these tests are mocks. The local database and isolated Redis used for validation
were stopped after use.
Final GitNexus comparison against `master` reports 37 tracked changed files,
116 changed symbols and 92 affected processes, with CRITICAL combined reach.
Expected paths are ingestion, scoring/inference, validation, suggestion admission,
broker lifecycle, browser quote transport and managed-service shutdown. New helpers
and regression files were also reviewed directly. Index status confirms current code;
only this audit document changed after indexing. No commit was created.

The regenerated real-data corpus contains 12,893 executed outcomes, 32 features and
28 out-of-sample monthly folds. The selected 876 outcomes average **−0.0229% net**, or
**−0.2229%** with another 10 basis points of slippage per leg. Both uncertainty intervals
include losses. Point-in-time universe provenance is unverified. Admission fails;
no replacement artifact was promoted. See [quantitative-validation.md](quantitative-validation.md)
and the accompanying machine-readable report for results and reproduction.

## Boundaries

Passing software checks does not establish profitable trading or prove that every
module is defect-free. Portfolio capital constraints, daily mark-to-market risk metrics,
historical universe/corporate-action provenance, derivatives/event predictive value,
intraday forecasts and additional horizons still lack sufficient validated evidence.
Score-only walk-forward selection is not a backtest of every live filter. Uncertain
broker outcomes require confirmed reconciliation; they must never trigger blind retry.
Broker acceptance is not fill confirmation. LIVE reservations require broker
reconciliation before realized P&L or margin release; an automated fill reconciler
has not been implemented. GTT protection is best-effort and can fail through gaps,
rejections or delivery authorization requirements.
Tick archival now restores recent observation keys from its durable JSONL file and
serializes flushes. Late and distinct same-timestamp ticks are retained without
re-appending restart overlap. Identical observations without an exchange sequence
remain indistinguishable and are stored once; this archive does not establish
microstructure predictiveness or exchange-level exactly-once capture.
Corporate-event windows and session-date helpers use weekdays without a verified
exchange holiday calendar. This remains a source-coverage limitation, particularly
around clustered holidays. Optional-data abstention can reduce availability.
GitNexus graph review works through the CLI; full-text search is unavailable because
its Windows native extension cannot load. Its execution-flow index is bounded and
does not establish exhaustive coverage of every dynamic call.
