# Mimir Signal-Quality Improvement Report

**Date:** 17 August 2026
**Scope:** Signal generation, paper-trading evaluation, India-market context, and validation
**Deployment scope:** Intentionally excluded; the current temporary local stack remains the focus

## Executive Summary

This pass focused on a high-risk source of model-quality distortion: unavailable AI components were being represented as neutral or zero-valued scores. Those values could contaminate stored signal records, factor explanations, later training data, and confidence interpretation. The pipeline now preserves unavailable model evidence as `null`, excludes unavailable components from confidence weighting, and renormalizes the remaining available weights. The fallback path also no longer reallocates unavailable AI weights into technical score, preventing degraded service conditions from overstating confidence.

The changes were implemented conservatively. They do not claim that the signal engine is profitable; they make its evidence, confidence, and learning data more honest and therefore more suitable for walk-forward evaluation.

## Implemented Changes

| Area | Previous behavior | Current behavior | Why it matters |
|---|---|---|---|
| AI composite score | Native fallback could persist `aiScore: 0` | Persists `aiScore: null` when no usable AI result exists | Prevents “zero” from being interpreted as a measured model score |
| Pattern score | Missing `bullish_probability` became `0` | Missing or invalid probability becomes `null` | Separates unavailable pattern evidence from bearish evidence |
| Chronos score | Missing Chronos result became `0` | Missing Chronos result becomes `null` | Avoids fabricated directional evidence |
| News sentiment | Missing sentiment became neutral `50`; native fallback emitted `50` | Missing sentiment remains `null` | Prevents unavailable news from masquerading as neutral information |
| Confidence calculation | All configured weights were implicitly used, even when a component was unavailable | Only available components contribute; their weights are renormalized | Confidence remains comparable without silently inventing evidence |
| Fallback confidence | Technical score absorbed weights for unavailable pattern, Chronos, and sentiment components | Fallback uses only technical, relative-strength, sector, and regime components, normalized over those weights | Degraded AI availability cannot inflate confidence |
| Confidence explanation | Fallback reasoning was labeled `[LEARNING ENABLED]` | AI path is labeled `[AI/LEARNING]`; fallback is labeled `[NATIVE FALLBACK]` | Operators can distinguish model-backed from fallback signals |
| Signal-factor breakdown | Hard-coded contribution percentages could disagree with adaptive weights | Contributions use the active adaptive weights and show null unavailable components | Stored explanations match the scoring path more closely |
| Decision trace | Missing sentiment could appear as a numerical neutral value | Trace preserves `sentiment_score: null` | Outcome-learning and audit trails retain data provenance |

## Research Basis

SEBI’s official July 7, 2025 comparative study on India’s equity-derivatives segment documents the importance of evaluating derivatives participation, market quality, and regulatory-era behavior as dated market-state variables rather than unconditional directional signals.[1] The implementation follows that principle by treating missing model evidence as missing, not as a neutral directional observation.

Transaction-cost and validation research also supports this conservative approach. Mimir’s existing economics layer ranks outcomes on net paper P&L rather than gross movement, while the current validation notes emphasize realistic costs, capacity, information-set discipline, and walk-forward evaluation. The system should be judged by stable net expectancy across time and regimes, not by a single confidence threshold or raw hit rate.[2] [3]

> A paper-trading system is only useful for learning if the recorded inputs represent what was actually known at the decision time.

## Validation Results

The current working tree passed the following final checks after the score-provenance changes.

| Check | Result |
|---|---:|
| Backend TypeScript check | Passed |
| Backend build | Passed |
| Backend lint | Passed |
| Backend tests | 24 test files, 81 tests passed |
| Focused signal-generator tests | 4 tests passed |
| Frontend TypeScript check | Passed |
| Frontend build | Passed |
| Frontend lint | Passed |
| Frontend tests | 3 test files, 6 tests passed |
| `git diff --check` | Passed |
| Runtime `/health` | HTTP 200 |
| Runtime `/ready` | HTTP 200; database, Redis, and market feed ready |
| Runtime trading mode | `PAPER`, `liveActive:false`, `paperOnly:true` |
| Runtime expectancy endpoint | HTTP 200 with honest null insufficient-sample metrics |
| Live-order compatibility route | HTTP 410; permanently disabled |

The restarted backend loaded successfully without new startup errors related to `scan_runs`, admin authentication, or WebSocket origin handling. Optional Upstox and AI services remain degraded when their external credentials/services are not configured; this is expected and is surfaced rather than converted into fabricated signal evidence.

## Remaining Highest-Value Improvements

The next improvement should be a leakage-resistant, cost-aware walk-forward evaluator that compares the new nullable-provenance signals against the prior scoring path. It should report net expectancy, confidence calibration, drawdown, turnover, and sample counts separately by setup, trade type, regime, direction, and data-quality state.

The second priority is to replace any remaining heuristic global-context zero defaults with explicit availability and freshness metadata. Macro, options, breadth, and institutional-flow inputs should contribute only when their timestamps and quality are acceptable; otherwise the composite should renormalize or pause the affected signal family.

The third priority is to expand test coverage around concurrent suggestion ingestion, pending-to-active fills, late-signal rejection, and database-backed capacity limits. These areas have greater practical impact on paper-trading realism than adding another unvalidated predictive feature.

## Disclosure

**Basis:** Signal confidence is computed from technical, relative-strength, sector, regime, and conditionally available AI components; unavailable components are excluded and weights are renormalized. Net paper outcomes use Mimir’s shared brokerage/tax/cost model.
**Time:** Validation and research checks were performed on 17 August 2026; runtime market values are session-dependent and not used as investment advice.
**Assumptions:** The system remains permanently paper-only, uses free/read-only market data, and treats missing external services as unavailable rather than imputing directional evidence.
**Sources & confidence:** The primary external source used in this pass was SEBI’s official research publication. Confidence in the code-quality conclusions is high because the final test, build, lint, type-check, and runtime checks passed; confidence in any trading edge remains unproven until sufficient out-of-sample paper outcomes accumulate.
**Compliance:** This is research and analysis only, not personalized financial advice.

## References

[1]: https://www.sebi.gov.in/reports-and-statistics/research/jul-2025/comparative-study-of-growth-in-equity-derivatives-segment-vis-vis-cash-market-after-recent-measures_95105.html "SEBI: Comparative study of growth in Equity Derivatives Segment vis-à-vis Cash Market after recent measures"
[2]: https://www.aqr.com/Insights/Research/White-Papers/Transactions-Costs-Practical-Application "AQR: Transaction Costs: Practical Application"
[3]: https://arxiv.org/abs/2512.12924 "Leakage-resistant walk-forward validation research"
