# Mimir Model Fixes Implemented

**Repository:** `Scifi-ally/Mimir`
**Working revision:** `9cfcb58` plus the uncommitted patch described below.
**Scope:** High-confidence code, data-contract, observability, documentation, and migration fixes identified during the model audit.

## Implemented changes

| Area | Fix | Result |
|---|---|---|
| Ranker labels | Timeout trades are no longer converted into wins merely because their realized return is positive. Only a true `WIN` receives label `1`; `LOSS` and `TIMEOUT` receive `0`. | Training target now matches documented `P(target1 before stop)` semantics. Timeout return remains available through `retPct`. |
| Training data | Extractor reports `WIN`, `LOSS`, and `TIMEOUT` counts and target-hit rate. | Training-data quality is more observable. |
| Training validation | Ranker loader rejects malformed feature widths and missing `resolutionTs` instead of silently accepting bad rows. | Prevents train/serve skew and invalid chronological purging. |
| Evaluation guard | Ranker training now requires at least 100 rows in both calibration and test slices by default. | Reduces promotion based on very small holdout windows. Override is available through `--min-eval-rows`. |
| Sentiment | Added headline deduplication after whitespace/case normalization. | Repeated stories across feeds no longer receive multiple votes by default. |
| Sentiment diagnostics | Added model name, fallback mode, failure count, last error, and cache TTLs to sentiment status. Runtime failure state resets after a successful inference. | Operators can distinguish FinBERT inference from keyword/neutral degradation. |
| Health endpoint | Added explicit ranker, confluence, RL-inference, and sentiment component status. Top-level ranking provider now depends on ranker availability rather than Chronos alone. | `/health` no longer implies all analysis systems are active when optional artifacts are missing. |
| Optional runtime health | Missing PyTorch no longer crashes health diagnostics. | CPU/minimal installations can still answer `/health` with truthful hardware status. |
| Confluence | Added `get_status()` with loaded regimes, artifact count, and fallback state. | Confluence artifact availability is visible. |
| PPO | Added explicit artifact, policy, loaded, healthy, and fallback status. | Trainable PPO code is not confused with an actually loaded RL model. |
| Signal observability | Corrected fallback reasoning label from `[LEARNING ENABLED]` to `[LEARNING DISABLED]`. | Decision traces no longer mislabel fallback decisions. |
| Documentation | Updated README and `docs/ARCHITECTURE.md` from stale XGBoost/Chronos-Tiny descriptions to actual LightGBM, Chronos-Bolt-Small, Technical Pattern Engine, optional confluence, and PPO paths. | Operational documentation now matches executable code. |
| Persistence default | Changed the AI-score model default from obsolete `NeoQuasar/Kronos-small` to `mimir-analysis-ensemble`. | New rows no longer claim to use a nonexistent Kronos model. |
| Database migration | Added `backend/drizzle/0012_fix_ai_score_model_name.sql` and journal entry `0012_fix_ai_score_model_name`. | Existing PostgreSQL installations can update the default safely. |
| Existing build issue | Removed duplicate `desc` import in `backend/src/routes/reports.ts`. | Backend TypeScript typecheck now passes. |

## Verification performed

The following checks passed after the patch:

| Check | Result |
|---|---:|
| Python compilation for modified AI modules | Passed |
| Python AI-service tests | **9 passed** |
| Backend TypeScript typecheck | Passed |
| Full backend Vitest suite | **20 files, 66 tests passed** |
| Targeted signal and feature tests | **4 passed** |
| Git whitespace validation | Passed |
| Drizzle journal JSON validation | Passed |
| AI-service health snapshot import/exercise | Passed; reports degraded status truthfully in the minimal environment |

The full Vitest suite emitted an existing mocked-DB warning from the signal-generator test while still passing; it is not a test failure.

## Items not changed automatically

Some improvements cannot be responsibly “fixed” by code edits alone because they require new historical data and out-of-sample evidence:

1. Sector-relative strength remains a training-data limitation when sector history is unavailable. It should be rebuilt from point-in-time sector series before adding or trusting that feature.
2. The committed ranker still needs retraining using the corrected labels. The patch corrects future extraction and training behavior but does not silently overwrite the production champion.
3. Chronos still requires comparison with naïve, drift, EMA, and existing fallback baselines before replacing the checkpoint.
4. FinBERT still requires timestamp-buffer, source-coverage, and historical headline provenance data before claiming a measurable sentiment edge.
5. Technical, Chronos, sentiment, and confluence outputs still need component-level calibration and reliability reporting.
6. PPO should not be promoted into the main signal path without beating supervised and deterministic baselines under the same purged walk-forward and cost assumptions.

These are deliberately left as validation tasks rather than being disguised as completed model improvements.

## Recommended next command

After collecting sufficient point-in-time training history, regenerate the corrected dataset and retrain with the stronger evaluation gate:

```bash
npm --prefix backend run ranker:extract
npm --prefix backend run ranker:train:only -- --min-eval-rows 100 --walk-forward
```

The retrained challenger should be promoted only if it passes the existing out-of-sample and champion-challenger gates.

*This is research and software/model analysis only, not personalized financial advice.*
