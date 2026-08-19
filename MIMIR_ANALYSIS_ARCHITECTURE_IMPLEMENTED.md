# Mimir Analysis Architecture — Implemented Changes

## Executive summary

Mimir's analysis path now has an explicit staged architecture instead of relying only on a large signal-generation function and implicit model-status conventions. The refactor is additive: existing signal fields and the AI-client API remain compatible, while every pipeline run can now expose a structured `AnalysisTrace` and every signal can reference that trace with `analysisTraceId`.

## Implemented architecture

| Boundary | Implementation | Improvement |
|---|---|---|
| Shared stage contract | `backend/src/analysis/analysis_contracts.ts` | Defines stage names, statuses, stage records, degraded-component tracking, `AnalysisEnvelope<T>`, and trace helpers. |
| Feature-to-model transport | `backend/src/analysis/inference_payload.ts` | Centralizes OHLCV column order and ranker-feature projection. |
| Ranker contract | `backend/src/analysis/ranker_contract.ts` | Makes the 32-feature order dependency-light and reusable without importing database-backed feature-engineering modules. |
| Compatibility surface | `feature_engine.ts` re-exports the ranker contract | Existing consumers keep their current imports while the contract has one canonical implementation. |
| Pipeline orchestration | `signal_generator.ts` | Records configuration, risk-state, market-context, activation, feature-engineering, health, model-inference, decision, and risk stages. |
| Per-decision correlation | `DecisionTrace.analysisTraceId` | Accepted and rejected signals can be correlated with the full run trace. |
| Pipeline-level visibility | `PipelineResult.analysisTrace` | Consumers can inspect stage status, durations, sources, reasons, and degraded components. |
| Node fallback health | `ai_client.ts` | Unavailable-service responses now expose the same component-level model status shape as the Python service. |
| Architecture documentation | `docs/ANALYSIS_ARCHITECTURE.md` | Documents stage ownership, contracts, fallback policy, and migration boundaries. |

## Stage semantics

The pipeline now records the following stages in order:

1. **Configuration:** adaptive weights are loaded through the staged contract and default weights remain the safe fallback.
2. **Risk state:** database-backed risk state is synchronized as a distinct single-source-of-truth stage.
3. **Market context:** regime and regime strength are recorded with the regime-detector source.
4. **Candidate activation:** scanner filtering records input and output candidate counts.
5. **Feature engineering:** the full candle-history feature contract and 32-feature ranker contract are recorded.
6. **AI health:** the service health response is recorded with ranking provider, component keys, and degraded reason.
7. **Model inference:** inference is classified as Python AI, native fallback, degraded, skipped, or unavailable based on actual result behavior.
8. **Decision gates:** accepted and rejected counts are recorded after all confidence and ranker gates run.
9. **Risk assessment:** accepted count and risk-rejection count are recorded as the final analysis stage.

## Fallback improvements

The architecture explicitly separates service capability from per-run behavior. A healthy AI service can still return a fallback-only batch, and the trace records that distinction. Conversely, an unavailable Python service produces a degraded `model_inference` stage with `source="native_fallback"` rather than pretending that a learned model scored the candidate.

The ranker transport boundary refuses to construct ranker features for incomplete realtime data. The new dependency-light contract makes this rule available without loading database-backed market-state modules, which improves test isolation and reduces architectural coupling.

## Verification

| Check | Result |
|---|---:|
| Backend TypeScript typecheck | Passed |
| New analysis-contract tests | 2 passed |
| New transport-boundary tests | 2 passed |
| Existing signal-generator and feature tests | 4 passed |
| Full backend Vitest suite | **22 files, 70 tests passed** |

## Remaining architectural work

The next logical step is to move Python model responses into a typed `ModelResult` envelope containing model name, model version, artifact hash, calibration status, fallback source, and per-component latency. Persisting `analysisTraceId`, model hashes, and feature-manifest hashes with signal outcomes would enable reproducible post-trade analysis and safe champion-challenger retraining. Those changes require a deliberate database migration and should be implemented before enabling automated model promotion.

The current refactor does not claim that any model has better predictive performance. It improves correctness, isolation, observability, and operational control so future model comparisons can be measured reliably.
