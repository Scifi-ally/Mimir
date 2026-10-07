# Signal-quality validation — 2026-10-02

**Research status: FAILED deployment gate. Profitable trading is not established.**

The audit followed stored/vendor candles through scanner setups, feature generation,
Python inference, signal scoring, suggestion ingestion, and historical outcome replay.
The council also corrected quote transport, source freshness and broker order lifecycle
defects. UI layout and styling were not changed.

## Recorded-data results

Local daily history: 119,374 bars across 97 instruments, September 2021–September 2026.
The extractor found 83 duplicate instrument sessions and excludes each affected history
from its earliest ambiguous session onward. It does not modify the database.

The corrected extraction yields 12,893 executed long cash-equity outcomes with 32
features. Five-session labels use subsequent bars, conservative limit-entry ordering,
opening-price gap stops, current Upstox cash-delivery fees, integer shares at INR
100,000 notional and five basis points of slippage on each leg. Equity shorts are
excluded. Turnover participation cannot exceed 0.1% of average daily traded value.
The current tariff is a conservative cost scenario, not a reconstruction of historical
broker invoices: https://upstox.com/brokerage-charges/

| Purged walk-forward, 28 folds | Baseline | Additional 10 bps per leg |
| --- | ---: | ---: |
| Selected trades | 876 | 876 |
| Mean net return per trade | -0.0229% | -0.2229% |
| Profit factor | 0.9811 | 0.8311 |
| Net-positive trade rate | 47.37% | 44.86% |
| Average positive return | +2.5103% | +2.4447% |
| Average negative return | -2.3033% | -2.3934% |
| Approximate 95% expectancy interval | [-0.3985%, +0.3527%] | [-0.5985%, +0.1527%] |

Uncertainty clusters stocks by entry date and adds conservative Bartlett HAC lag five
for overlapping outcomes. These are trade statistics, not an executable portfolio
backtest. Sharpe, Sortino and maximum drawdown remain unavailable because capital
allocation and a daily marked-to-market portfolio have not been reconstructed.

## Corrections and admission rules

- Daily features become available at NSE cash close (15:30 IST), independently of
  vendor midnight/open timestamps. Legacy institutional flow is unavailable to training
  because the database does not preserve source/publication provenance. New ingestion
  validates numeric fields and actual source dates instead of assigning today's date.
- NIFTY strength matches actual trading sessions in both research and scanning. Sector
  strength uses the full observed peer population, excludes self and requires two peers.
- EMA200 requires 201 observations. Missing institutional flow uses native model missing
  values; missing core inputs, duplicate/incomplete/stale sessions and invalid OHLCV fail closed.
- Confidence preserves calibrated target-before-stop probability. Heuristic scores and
  live-flow/news boosts cannot alter that probability. Bearish factors respect SELL direction.
- Threshold selection is confined to calibration history. Both split boundaries purge
  unresolved labels. Test dates are evaluated once per fold, without retraining on their labels.
- Training and walk-forward evaluation share model parameters and threshold selection.
  Fixed deployment thresholds are rejected. Scope verification binds admission to five
  sessions, BUY cash equity, costs, notional and recorded 20-session turnover. Artifact
  metadata verifies the model SHA-256; inference captures one model/calibration snapshot.
- Zero-volume equity candles cannot supply replay fills. Index candles may retain zero
  volume. Corrupt and duplicate equity observations do not become fabricated prices.
- Per-feature permutation Brier lift, fold results, calibration bins and cost stress are
  preserved in `quantitative-validation-2026-10-02.json`. Test diagnostics do not select
  features or tune the model on the same holdout.
- Training and loading reject models without positive stressed uncertainty bounds and
  verified point-in-time universe provenance. The shipped artifact has neither; automated
  suggestion paths therefore abstain. The daily model cannot authorize intraday or cash shorts.

## Remaining evidence gaps

The stored universe reflects current membership, not historical listings/delistings;
survivorship bias cannot be ruled out. Corporate-action adjustment and historical
sector membership provenance need verification. The daily OHLCV corpus does not establish
intrabar ordering, live order-book predictiveness, historical derivatives/news/event
effects, or a validated intraday edge. No new stop-hit, favorable-movement, expected-return
or excursion probabilities are fabricated. Multi-horizon models and portfolio/regime
validation remain further work, not claims of this change.
The score-only research selection also differs from additional live confidence and risk
filters; its statistics must not be presented as measured full-system live expectancy.

## Reproduce

With the existing PostgreSQL configured and the project's Python environment available:

```powershell
cd backend
npm run ranker:extract -- --days 1900 --holdBars 5 --out ../.codex-logs/quant-training-clean.jsonl
cd ..
.venv/Scripts/python.exe backend/ai_service/walk_forward_harness.py --data .codex-logs/quant-training-clean.jsonl --report .codex-logs/quant-validation-clean.json
npm --prefix backend run typecheck
npm --prefix backend test
.venv/Scripts/python.exe -m pytest -q backend/ai_service
```

Validation exit code 1 means the strategy failed its admission criteria. No artifact is
promoted and no trade is placed by these commands. Exact extraction depends on the date
and local database; the saved report includes the evaluated JSONL SHA-256.
