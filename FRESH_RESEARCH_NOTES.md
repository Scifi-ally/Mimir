# Fresh Mimir Research Notes

## Upstox API rate limits
Source: https://upstox.com/developer/api-documentation/rate-limiting/ (accessed 2026-08-17).

The official Upstox documentation states that limits are enforced per API and per user. For regular order-placement APIs, including place, modify, cancel, multi-order, and GTT, the limit is 10 requests per second, 500 per minute, and 2,000 per 30 minutes. Other standard APIs, including holdings, positions, funds, and historical candles, are limited to 50 requests per second, 500 per minute, and 2,000 per 30 minutes. Exceeding limits can result in temporary access suspension. Mimir is paper-only, so order-placement and cancellation calls should remain unreachable; read-only market-data calls still require global per-minute and per-30-minute budgeting, not only per-second throttling.

## SEBI India derivatives study
Source: https://www.sebi.gov.in/reports-and-statistics/research/jul-2025/comparative-study-of-growth-in-equity-derivatives-segment-vis-vis-cash-market-after-recent-measures_95105.html (accessed 2026-08-17).

SEBI published a comparative study on 2025-07-07 covering growth in India’s equity-derivatives segment versus the cash market after recent measures. The study is a primary source for Mimir’s derivatives participation, market-quality, retail-behavior, and regulatory-regime features. The implementation implication is to treat derivatives activity and liquidity as state variables with dated snapshots, not as unconditional directional signals; participant composition, expiry state, and cost/capacity must be evaluated out of sample.

## Professional implementation and validation
Source: https://www.aqr.com/Insights/Research/White-Papers/Transactions-Costs-Practical-Application (accessed 2026-08-17).

AQR emphasizes that transaction costs are necessary for implementing any strategy and that overly simplified cost analysis can produce erroneous conclusions. Mimir should therefore rank signals on expected net paper P&L after brokerage, taxes, spread, slippage, impact, and capacity—not on raw confidence or gross return alone.

Source: https://arxiv.org/abs/2512.12924 (accessed 2026-08-17).

The paper presents a leakage-resistant walk-forward framework with rolling out-of-sample periods, strict information-set discipline, realistic costs and position constraints, and explicit regime dependence. Its reported aggregate results are modest and statistically insignificant, which is a useful caution: Mimir should report uncertainty and stability, not imply that a profitable backtest proves a durable edge.

Source: https://www.sebi.gov.in/media-and-notifications/press-releases/sep-2024/updated-sebi-study-reveals-93-of-individual-traders-incurred-losses-in-equity-fando-between-fy22-and-fy24-aggregate-losses-exceed-1-8-lakh-crores-over-three-years_86906.html (accessed 2026-08-17).

SEBI’s official release reports that 93% of individual equity-F&O traders incurred losses between FY22 and FY24 and that aggregate losses exceeded ₹1.8 lakh crore over three years. This supports conservative filters for expiry, turnover, costs, leverage-like exposure, and paper-only evaluation; it does not justify adding more speculative directional signals.

## Runtime verification

On 2026-08-17, the exposed dashboard loaded successfully at the configured HTTPS URL. The dashboard displayed `PAPER ONLY`, `OFFLINE / STANDBY awaiting market data`, and read-only Upstox authorization controls. The Settings dialog displayed `PAPER-ONLY SIGNAL ENGINE`; the execution tab no longer offered live-mode arming or broker-order controls. The local backend health endpoint returned `status: ok`; `/api/trading/mode` returned `mode: PAPER`, `liveActive: false`, and `paperOnly: true`; `/api/trading/live/orders` returned HTTP 410 with the permanent paper-only error.

## Improvement-pass research update (2026-08-17)

The official SEBI page reviewed during this pass confirms the July 7, 2025 comparative study on growth in India’s equity-derivatives segment versus the cash market after recent measures. The implementation implication remains conservative: derivatives activity, liquidity, expiry state, and participant composition should be modeled as dated state variables and validated out of sample, not treated as unconditional directional signals.

## Scrapeverse integration research (2026-08-17)

Bright Data official Scraper Studio quickstart: https://docs.brightdata.com/datasets/scraper-studio/quickstart. The API triggers an asynchronous collector with `POST https://api.brightdata.com/dca/trigger?collector=<collector_id>&queue_next=1`, using `Authorization: Bearer <BRIGHT_DATA_API_TOKEN>` and a JSON array of inputs. It returns a `collection_id`; `GET https://api.brightdata.com/dca/dataset?id=<collection_id>` returns a status object while building and a JSON array when ready.

Bright Data official CLI guide: https://docs.brightdata.com/datasets/scraper-studio/build-with-the-cli. The CLI is available through `npx -p @brightdata/cli bdata`; the documented flow is `bdata login`, `bdata scraper create <url> <description>`, then `bdata scraper run <collector_id> <url>`. A stable `c_*` collector ID is required. No Bright Data connector or token is currently present in the Manus connector configuration, so live collector creation/run and self-healing evidence cannot be claimed until the user provides/authorizes Bright Data access.
