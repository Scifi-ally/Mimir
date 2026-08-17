# Mimir

Mimir is an **India-focused market-intelligence and signal-generation system** for NSE/BSE equities. It combines read-only market data, technical analysis, India-specific market context, optional AI inference, risk gates, realistic paper execution, and a React dashboard.

> **Permanent safety boundary:** Mimir is a signal-only, paper-trading system. It does not place, modify, cancel, or mirror live broker orders. The backend forces `PAPER` mode, broker-order compatibility endpoints fail closed with HTTP `410`, and the frontend does not expose live-trading controls.

> **Financial disclaimer:** Mimir is a research and analysis system, not investment advice. A paper signal is not a prediction guarantee, and historical or simulated performance does not establish future profitability. Users are responsible for independent due diligence and risk decisions.

## Contents

1. [What Mimir Does](#what-mimir-does)
2. [Architecture Principles](#architecture-principles)
3. [System Topology](#system-topology)
4. [Runtime Lifecycle](#runtime-lifecycle)
5. [Market-Data Ingestion](#market-data-ingestion)
6. [India-Market Intelligence](#india-market-intelligence)
7. [Signal-Generation Pipeline](#signal-generation-pipeline)
8. [Confidence and Data Provenance](#confidence-and-data-provenance)
9. [Suggestion Ingestion and Freshness](#suggestion-ingestion-and-freshness)
10. [Paper Execution and Trade Economics](#paper-execution-and-trade-economics)
11. [Persistence and Learning](#persistence-and-learning)
12. [Realtime WebSocket Architecture](#realtime-websocket-architecture)
13. [Scheduler and Market Sessions](#scheduler-and-market-sessions)
14. [Frontend Architecture](#frontend-architecture)
15. [Security and Safety Model](#security-and-safety-model)
16. [Upstox Quota Safety](#upstox-quota-safety)
17. [Repository Layout](#repository-layout)
18. [Local Development Setup](#local-development-setup)
19. [Docker Compose](#docker-compose)
20. [HTTP and WebSocket Interfaces](#http-and-websocket-interfaces)
21. [Testing and Validation](#testing-and-validation)
22. [Observability and Troubleshooting](#observability-and-troubleshooting)
23. [Architecture Trade-offs and Limitations](#architecture-trade-offs-and-limitations)
24. [Future Improvement Model](#future-improvement-model)
25. [References](#references)

## What Mimir Does

Mimir continuously builds a point-in-time view of the Indian market, detects candidate setups, evaluates them through layered technical and market-state filters, optionally requests AI-assisted ranking, and publishes only quality-filtered paper suggestions. A suggestion contains an entry hypothesis, stop-loss, targets, expected holding period, risk framing, confidence, data-quality metadata, and a decision trace.

The system has two operating dimensions that must not be confused:

| Dimension | Current behavior |
|---|---|
| **Signal generation** | Produces technical and optionally AI-assisted market signals for India-focused instruments. |
| **Execution** | Permanently paper-only. Paper fills, paper positions, paper P&L, and paper analytics are recorded; broker order placement is disabled. |
| **Market data** | Read-only Upstox data when configured, with free/public NSE/BSE and other free-source fallbacks where available. |
| **External AI** | Optional FastAPI service. If unavailable, Mimir uses an explicitly labeled native fallback path rather than pretending AI evidence exists. |
| **User interface** | React/Vite dashboard with REST hydration and two realtime WebSocket channels. |

The design prioritizes **honest evidence, fast enough signals, realistic costs, and safe degradation** over maximizing the number of generated suggestions.

## Architecture Principles

### Paper-only by construction

Paper-only behavior is enforced at several independent layers. Configuration loading forces `paperTradingEnabled: true` and `tradingMode: "PAPER"`. The broker-order module reports that live mode is never active. The paper engine does not mirror entries or exits to a broker. Legacy live-account and live-order routes return HTTP `410`. The frontend removes live-mode arming and live-broker controls. Regression tests continuously exercise this boundary.

This defense-in-depth design is intentional. A configuration flag alone is not considered a sufficient safety boundary for a financial system.

### Point-in-time information discipline

Signals must be based on information available at their generation time. Market-data freshness gates reject stale inputs, signal ingestion rejects missing or invalid timestamps, and the paper engine records the actual fill moment separately from the generation moment. Outcome measurement therefore uses the fill-time evaluation window wherever possible.

### Provenance over fabricated defaults

Unavailable data is represented as unavailable. For example, missing AI pattern, Chronos, sentiment, or composite scores remain `null`; they are not converted into zero or neutral `50` values. Confidence excludes unavailable components and renormalizes the remaining weights. This prevents degraded data sources from silently contaminating ranking, explanations, calibration, and future training data.

### Net economics over gross movement

Paper P&L uses a shared trade-economics module. Position sizing, brokerage, taxes, transaction costs, and net P&L are not independently reimplemented by each subsystem. A signal that looks profitable before costs but fails after costs should not be treated as a successful paper opportunity.

### India-specific context is a state layer, not a universal directional oracle

Breadth, sector rotation, FII/DII flow context, options information, macro transmission, event risk, liquidity, and market regime are treated as dated market-state inputs. They confirm or suppress candidate signals; they are not assumed to predict every individual stock movement.

### Backpressure and graceful degradation

High-frequency market ticks are ephemeral. Slow WebSocket clients may have tick batches dropped rather than causing unbounded memory growth. External-service failures are logged and surfaced through health and data-quality status. The system may continue in a degraded native-fallback mode, but the resulting signal records preserve that degraded provenance.

## System Topology

The main runtime consists of a browser dashboard, an Express/TypeScript backend, PostgreSQL, Redis, and an optional Python AI service.

```mermaid
graph TD
    U[Upstox read-only WebSocket / REST] --> CM[Upstox Connection Manager]
    NSE[NSE/BSE free public data] --> MF[Market Feed and India Context]
    YF[Free macro / quote sources] --> MF
    CM --> BUS[In-memory intelligence bus]
    BUS --> TD[Tick feeder and distribution]
    TD --> CANDLE[OHLCV candle builder]
    TD --> ORCH[Intelligence orchestrator]
    CANDLE --> FEAT[Feature engine]
    MF --> FEAT
    ORCH --> SCAN[Stock scanner and candidate setup detection]
    SCAN --> FEAT
    FEAT --> SG[Signal generator]
    SG -->|optional batch inference| AI[FastAPI AI service]
    AI --> SG
    SG --> GATE[Freshness, India, expectancy, risk, and capacity gates]
    GATE --> DB[(PostgreSQL)]
    GATE --> BUS2[Suggestion events]
    BUS2 --> PE[Paper execution engine]
    PE --> DB
    DB --> LEARN[Accuracy, outcome, calibration, and learning jobs]
    REDIS[(Redis)] --> BUS
    REDIS --> WS[WebSocket alert fanout]
    BUS2 --> WS
    TD --> WS
    WS --> FE[React/Vite dashboard]
    DB --> FE
    FE -->|REST and WebSocket| API[Express API]
    API --> DB
```

### Service responsibilities

| Service | Responsibility | Default interface |
|---|---|---|
| **Frontend** | Dashboard, charts, suggestions, paper account, reports, settings, and realtime subscriptions. | Vite development server on `3000`; nginx container on `3000`. |
| **Backend** | HTTP API, WebSockets, market-data orchestration, signal generation, scheduler, paper engine, risk, learning, and persistence coordination. | Express and WebSockets on `5000`. |
| **PostgreSQL** | Durable configuration, suggestions, outcomes, paper account, paper positions, learning analytics, candles, scan runs, and reports. | `DATABASE_URL`. |
| **Redis** | Hot state, distributed locks, API-rate-limit state, realtime alert pub/sub, WebSocket subscriber state, and cached market data. | `REDIS_URL`. |
| **AI service** | Optional pattern, forecasting, sentiment, and calibrated ranker inference. | FastAPI on `8001`, normally backend-internal. |
| **Upstox** | Read-only market data and optional OAuth token storage. | REST and binary WebSocket APIs. Live trading is not used. |

## Runtime Lifecycle

The backend entrypoint is `backend/src/index.ts`. Startup order matters because background jobs must not query an incomplete database or publish realtime events before transports exist.

1. Environment files are loaded. `.env.local` has precedence over `.env` for local development.
2. Process-level rejection and exception guards are installed.
3. Security mode is logged.
4. The HTTP server and both WebSocket channels are initialized.
5. A schema probe verifies that required migrations, including `activated_at`, are present. Startup exits rather than silently operating against an incompatible schema.
6. The `scan_runs` persistence table is ensured before scheduler activity begins.
7. Database-backed configuration and the persisted Upstox access-token state are restored.
8. The scheduler, broker-reconciliation compatibility loop, paper engine, and market-intelligence orchestrator start.
9. The server listens on `0.0.0.0:${PORT}`.
10. On `SIGINT` or `SIGTERM`, HTTP accepts no new connections, background jobs stop, in-flight work receives a short drain period, PostgreSQL closes, Redis closes, and the process exits.

The application exposes three process probes:

| Probe | Meaning |
|---|---|
| `GET /health` | Process liveness. It confirms that the Node process can answer. |
| `GET /live` | Simple liveness alias intended for process monitoring. |
| `GET /ready` | Dependency readiness. It checks PostgreSQL, Redis, and the market-feed status. A failed dependency returns HTTP `503`. |

## Market-Data Ingestion

### Upstox connection lifecycle

`backend/src/intelligence/connection_manager.ts` owns the read-only Upstox feed lifecycle. It authorizes the market-data WebSocket, decodes the binary protobuf feed, normalizes instrument keys and quotes, maintains connection state, and reconnects with bounded exponential backoff. When the socket is disconnected or silent, a REST LTP fallback can keep basic market state alive.

`backend/src/lib/upstox-client.ts` centralizes REST access. It maintains canonical cache keys and separate TTLs for LTP, quotes, intraday candles, and historical candles. It also applies a process-wide rolling request budget across one-second, one-minute, and thirty-minute windows.

### Tick processing

Ticks pass through several transformations:

| Stage | Function |
|---|---|
| Raw feed | Binary Upstox feed response or REST fallback. |
| Normalization | Symbol, LTP, volume, bid, ask, timestamp, and change fields are normalized. |
| Sanity checks | Invalid or non-positive prices and materially invalid timestamps are dropped. Zero bid/ask values remain zero; fake spreads are not invented. |
| Tick state | Recent state is kept in memory and mirrored to Redis where configured. |
| Candle construction | The candle builder aggregates supported intervals such as `1m`, `5m`, `15m`, `30m`, `1h`, and `1d`. |
| Distribution | UI tick batches and internal `processedTick` events are emitted separately. |
| Intelligence | The orchestrator debounces and routes candidate work to scanner, feature, and signal subsystems. |

The system intentionally does not claim to be a colocated high-frequency trading engine. It is an event-driven market-intelligence application with bounded queues and retail-scale latency expectations.

## India-Market Intelligence

`backend/src/analysis/india_market_state.ts` is the shared India-context contract. It builds a provenance-aware market context and evaluates whether a candidate is tradeable under current conditions.

### Context families

| Context family | Examples | Primary use |
|---|---|---|
| **Liquidity and spread** | LTP availability, bid/ask quality, volume, stale-feed checks. | Hard tradeability gates and realistic execution assumptions. |
| **Breadth and internals** | Advances/declines, tick-style internals, market breadth, VIX behavior. | Direction confirmation and market-wide risk suppression. |
| **Sector rotation** | Sector strength, top-sector ranking, market participation. | Preventing isolated momentum signals from fighting sector flow. |
| **Institutional flow** | FII/DII context and lagged institutional-flow features. | Contextual confirmation; not treated as an instantaneous predictor. |
| **Options surface** | PCR and option-chain context where free data is available. | Market sentiment and expiry-aware risk context. |
| **Macro transmission** | USD/INR, India VIX, crude, US yields, DXY, India rates, scheduled events. | Risk regime and event-risk multipliers. |
| **Corporate and calendar events** | Earnings, corporate actions, holidays, expiry/session state. | Blackouts, demotions, or tighter thresholds. |

### Provenance quality

Every market context is classified as `FULL`, `PARTIAL`, or `UNAVAILABLE` according to the freshness and completeness of its inputs. A partial context may still contribute to diagnostics or hard liquidity checks, but it must not be mistaken for a complete institutional confirmation layer.

`evaluateIndiaTradeability()` is integrated into risk assessment and scanning. `computeIndiaSignalAdjustment()` applies direction-aware confirmation or penalty logic. The feature engine attaches India metadata to the feature vector while preserving the ranker contract separately.

Free public data is inherently imperfect. NSE pages can be delayed, rate-limited, or unavailable, and some macro values are estimates when no free live source exists. Estimated values are flagged and must not create a permanent directional bias.

## Signal-Generation Pipeline

The signal path is distributed across the orchestrator, scanner, feature engine, signal generator, risk engine, and suggestion generator. It is not a single monolithic “seven-stage AI engine.”

```mermaid
sequenceDiagram
    participant Feed as Market feed
    participant Orch as Orchestrator
    participant Scan as Scanner
    participant Feat as Feature engine
    participant AI as Optional AI service
    participant Signal as Signal generator
    participant Risk as Risk engine
    participant Store as Suggestion generator
    participant Paper as Paper engine

    Feed->>Orch: processedTick / candleClosed
    Orch->>Scan: candidate setup request
    Scan->>Feat: build point-in-time FeatureVector
    Feat-->>Scan: technical + India context
    Scan->>Signal: candidate batch
    Signal->>AI: batch inference when configured and complete
    AI-->>Signal: pattern / Chronos / sentiment / ranker results
    Signal->>Risk: candidate confidence and setup
    Risk-->>Signal: pass, warnings, sizing, or rejection
    Signal->>Store: IntelligenceSignal
    Store->>Store: freshness, duplicate, capacity, expectancy, event, and price gates
    Store->>Paper: suggestionTriggered for accepted paper signal
    Paper->>Store: fill, status, P&L, and outcome updates
```

### Stage 1: Candidate detection

The stock scanner detects setup candidates such as momentum, breakout, mean-reversion, and other configured setup types. It applies basic market, sector, liquidity, corporate-action, and data-quality constraints before expensive inference.

### Stage 2: Feature assembly

`backend/src/analysis/feature_engine.ts` computes technical and market-context features, including momentum, RSI, MACD-derived scores, ATR, ADX, volume ratios, EMA alignment, VWAP distance, relative strength, sector strength, realized volatility, candle structure, risk/reward framing, order-book imbalance where available, and India-context metadata.

A ranker feature vector is created only when the required feature contract is complete. A stale or incomplete realtime vector is marked accordingly rather than padded with invented data.

### Stage 3: Optional AI inference

When `AI_SERVICE_URL` and the service token are configured, the backend can request batch inference. The optional service may provide:

| Component | Role | Signal authority |
|---|---|---|
| Technical pattern engine | Pattern and directional probability. | Part of AI-backed ranking when a genuine result is returned. |
| Chronos-Bolt-Small | Time-series forecast and directional forecast return. | Confluence component, not an independent trade command. |
| FinBERT/news sentiment | News and macro headline sentiment. | Advisory component only. Missing sentiment is `null`. |
| Calibrated LightGBM ranker | Estimated probability of target success before stop. | Can reject candidates below configured probability threshold when the ranker is genuinely available. |
| Native TypeScript fallback | Technical and market-state confidence when AI is unavailable. | Explicitly labeled fallback; no AI score is fabricated. |

The backend uses circuit-breaking and timeouts so a slow or unavailable AI service does not block the entire market-data event loop.

### Stage 4: Confidence and regime logic

Confidence combines technical quality, relative strength, sector strength, regime, and conditionally available AI components. If a component is unavailable, it is excluded and the remaining configured weights are renormalized. This means a degraded signal may still be generated through the fallback path, but its stored provenance and explanation clearly identify the degradation.

High-volatility regimes receive a confidence penalty and stronger risk treatment. Incompatible regime-direction combinations may be blocked. Minimum confidence, risk/reward, India tradeability, event risk, and liquidity settings are configuration-controlled but paper-only mode remains non-negotiable.

### Stage 5: Risk assessment

`backend/src/analysis/risk_engine.ts` checks stop distance, risk/reward, account capacity, daily loss state, open-position caps, sector and direction exposure, market liquidity, India tradeability, and event/regime constraints. It uses shared safe sizing and can return a position size of zero when a trade is not affordable or does not satisfy risk constraints. There is no forced one-share minimum.

### Stage 6: Suggestion ingestion

`backend/src/suggestions/generator.ts` accepts a signal only after it passes timestamp freshness, duplicate, capacity, setup expectancy, price sanity, corporate action, F&O ban, delivery, market-internals, gap-risk, and risk gates. Expensive or stateful work is placed after early rejection checks where possible.

## Confidence and Data Provenance

### Nullable AI evidence

Mimir distinguishes these states:

| Value | Meaning |
|---|---|
| A finite numeric score | The component produced a usable score at signal time. |
| `null` | The component was not available, invalid, stale, or intentionally excluded. |
| Fallback confidence path | The system used native technical/market-state scoring because usable AI evidence was not available. |
| `confidencePath: "python_confluence"` | The optional inference service returned a usable confluence score. |

The system never treats `0` as a universal “missing” marker for AI components. This matters for both operational interpretation and future model training: an absent news feed is not bearish news, and an unavailable Chronos forecast is not a zero forecast.

### Decision traces

Each signal carries a decision trace containing regime, regime strength, optional forecast details, sentiment provenance, ranker probability where available, confidence path, ranker-blend status, rejection gate when rejected, and top SHAP values when supplied by the AI service. The trace is an audit record, not a guarantee that the signal will win.

## Suggestion Ingestion and Freshness

Late signals have little practical value for intraday decisions. `backend/src/suggestions/signal_freshness.ts` applies a configurable age policy before persistence and paper execution visibility.

| Trade type | Default maximum age | Environment override |
|---|---:|---|
| `INTRADAY` | 5 minutes | `MIMIR_MAX_INTRADAY_SIGNAL_AGE_MINUTES` |
| `SWING` | 60 minutes | `MIMIR_MAX_SWING_SIGNAL_AGE_MINUTES` |

Missing timestamps and invalid timestamps are rejected explicitly. Future timestamps are tolerated as fresh with age telemetry clamped to zero to avoid rejecting a signal because of small clock skew.

Realtime opportunities are stamped when constructed so the freshness gate measures actual signal latency rather than replacing the original generation time with ingestion time.

## Paper Execution and Trade Economics

### Paper lifecycle

A suggestion may be inserted as `PENDING` when the planned entry has not yet been touched or `ACTIVE` when an entry condition is already satisfied. The paper engine evaluates fills against current market state and preserves the distinction between planned generation time and actual activation/fill time.

The lifecycle generally follows:

```text
candidate -> signal -> accepted suggestion -> PENDING or ACTIVE
         -> paper fill -> open position -> target / stop / expiry / manual paper close
         -> verified outcome -> analytics and calibration
```

The system does not call broker order-placement APIs during any of these transitions.

### Shared economics

`backend/src/trading/trade_economics.ts` is the shared source of truth for safe sizing and net P&L. It is used by the risk engine, paper engine, accuracy tracker, and outcome verifier.

The economics layer accounts for the configured trade type, direction, quantity, entry and exit, brokerage and statutory costs, and other configured cost assumptions. Reports therefore distinguish gross price movement from net paper P&L. A setup should not be promoted merely because its gross target was reached if the realized net economics are negative.

### Outcome verification

Outcomes are labeled only after a trade is decided. The system records fill-time duration, realized net P&L, status, outcome price, verification timestamp, and relevant signal metadata. Historical outcome backfill uses the same shared economics instead of an independent flat-cost formula.

## Persistence and Learning

PostgreSQL is the durable source of record. Important tables include:

| Table family | Purpose |
|---|---|
| `suggestions` | Generated signal records, scores, feature vector, decision trace, status, fill, outcome, and P&L. |
| Paper-account tables | Paper balance, allocations, orders, positions, and account activity. |
| Outcome and learning tables | Verified outcomes, calibration samples, learning metrics, setup analytics, and adaptive settings. |
| Market-data tables | Candles, scan runs, and selected historical market state. |
| Configuration and access-token state | Paper-safe system settings and encrypted/persisted read-only auth state where configured. |

Redis is used for hot state and coordination rather than as the authoritative trade ledger. It supports cached ticks, distributed locks, API-rate-limit state, alert pub/sub, WebSocket subscriber fanout, and fast dashboard hydration.

The learning loop is intentionally conservative:

1. Only decided trades become calibration samples.
2. Metrics with insufficient samples return `null` rather than fabricated 50% baselines.
3. Setup, regime, direction, and trade-type analytics are reported separately.
4. Calibration and demotion jobs run after outcome verification.
5. Learning output is treated as a controlled input to future ranking and risk, not as an automatic proof of edge.

## Realtime WebSocket Architecture

Mimir exposes two WebSocket channels:

| Channel | Purpose |
|---|---|
| `/ws/intelligence` | Suggestions, alerts, session changes, system status, breadth, and intelligence events. |
| `/ws/market-data` | High-frequency market ticks and symbol-specific market data. |

The frontend opens both channels and uses binary MessagePack-compatible payload handling where configured. Clients can subscribe to topics, active symbols, and bounded watchlists.

### Realtime safety behavior

The WebSocket server:

- checks the request origin against the allowed-origin policy;
- auto-authenticates local development clients under the explicit local paper-only policy;
- requires token-based authentication for remote access unless a deliberate remote-auth bypass is configured;
- rate-limits repeated authentication attempts and temporarily bans abusive sources;
- caps per-client subscribed symbols;
- sends heartbeat pings and closes dead connections;
- drops ephemeral tick batches for slow readers when the send buffer grows;
- terminates clients that exceed the hard backpressure cap;
- filters market ticks by the client’s active symbol and subscriptions;
- receives alert fanout through Redis pub/sub.

Local no-token mode is a convenience for the local paper-only development service. It must not be used as a public-internet security model.

## Scheduler and Market Sessions

The scheduler in `backend/src/scheduler/jobs.ts` uses IST-aware session logic, cron jobs, interval jobs, and Redis-backed exclusivity locks. It is responsible for keeping the market state, intelligence, outcomes, and learning loop moving without duplicate work across instances.

| Timing | Job family | Purpose |
|---|---|---|
| Startup | Baseline refresh | Prime macro, options, FII/DII, market state, calibration, and scan state. |
| Every minute | Session and safety | Update market session state, outcome checks, daily-loss checks, and custom screener due checks. |
| Every 10 seconds during market hours | Realtime feed refresh | Refresh market feed state under an exclusive lock. |
| Every 2 minutes during market hours | Market feed and regime | Update Nifty/VIX and regime inputs. |
| Every 5 minutes during market hours | Macro/options | Refresh macro and options sentiment context. |
| Every 15 minutes during market hours | Intraday generation | Generate watchlist-based intraday suggestions. |
| Hourly / scheduled | Watchlist and automation health | Enrich monitored symbols and pause automation when recent paper performance degrades. |
| Pre-market | FII/DII, corporate actions, NSE free data, gap risk | Build dated context before signals are eligible. |
| 09:15 IST | Market open | Start monitoring when pre-market work is complete. |
| 15:30 IST | Market close | Stop tick monitoring and intraday activity. |
| 15:31–16:15 IST | Post-market | Full scan, expire intraday signals, verify outcomes, save statistics, run learning, refresh calibration, and generate reports. |
| Midnight IST | Cleanup | Expire old suggestions and reset market-feed cache. |
| Weekly | Alpha and demotion checks | Recalculate selected analytics and demote weak setup families when evidence supports it. |

Distributed locks prevent duplicate market-open, feed, scan, and other critical jobs when multiple backend processes are accidentally started.

## Frontend Architecture

The frontend is a React 19 application built with Vite, TypeScript, Tailwind CSS, TanStack Query, Zustand, lightweight-charts, Framer Motion, and PWA support.

The dashboard uses:

| Concern | Implementation |
|---|---|
| Server state | TanStack Query for REST data, loading, caching, and invalidation. |
| Local UI state | Zustand and component state for layout, selected symbols, panels, and user preferences. |
| Market data | WebSocket provider and symbol-indexed market state. |
| Charts | `lightweight-charts` with actual candles and forecast overlays where available. |
| Reports | Markdown rendering and structured expectancy/performance views. |
| Responsive layout | Tailwind-based component system and resizable panels. |
| Offline/installable shell | Vite PWA plugin for browser caching and standalone metadata; this does not make the backend offline-capable. |
| Desktop option | Tauri scripts exist, but the primary product architecture is a web dashboard. |

In development, Vite serves the frontend on `3000` and proxies `/api` and `/ws` to the backend on `5000`. In the Docker topology, nginx serves the built frontend and proxies requests to the backend.

## Security and Safety Model

### HTTP security

The Express application applies compression, security headers, structured request logging, CORS checks, cookies, JSON/body limits, API rate limiting, route authentication, validation handling, and centralized error shaping.

Health probes are intentionally outside the authenticated `/api` route group so monitoring can determine whether the process is alive and ready. Business routes are protected by the local/remote security policy.

### Local access

For local paper-only development, loopback and approved private origins can access the dashboard without a browser admin-token prompt. The local backend records that no-token development mode is active. This removes friction for local use; it is not a recommendation to expose the service publicly without authentication.

### Remote access

Remote API and WebSocket clients should use a strong `UPSTOXBOT_ADMIN_TOKEN`, an explicit allowed-origin configuration, a stable `UPSTOXBOT_SECRET_KEY`, and a TLS-terminating reverse proxy or equivalent. Do not enable `DISABLE_REMOTE_API_AUTH=1` on an internet-exposed service.

### Secrets

Secrets belong in environment variables or the project’s encrypted persistence mechanism. Never commit `.env`, access tokens, API secrets, database passwords, or AI service tokens. Rotate credentials if they are ever printed in logs, screenshots, shell history, or commits.

### Live execution boundary

The following interfaces are intentionally unavailable:

| Interface | Behavior |
|---|---|
| `GET /api/trading/mode` | Returns `PAPER`, `liveActive:false`, and `paperOnly:true`. |
| `POST /api/trading/mode` | Returns HTTP `410`. |
| `/api/trading/live/positions` | Returns HTTP `410`. |
| `/api/trading/live/funds` | Returns HTTP `410`. |
| `/api/trading/live/orders` | Returns HTTP `410`. |
| Broker placement/cancellation helpers | Refuse execution regardless of stored mode values. |

## Upstox Quota Safety

Mimir uses Upstox as a read-only market-data source. It must not call order-placement APIs. The current client applies process-wide rolling budgets with safety margins below the documented market-data quotas. Upstox documents separate per-user/per-API limits, including 50 requests per second, 500 per minute, and 2,000 per 30 minutes for standard market-data APIs; exceeding limits can result in temporary access suspension.[1]

The client therefore uses:

| Control | Purpose |
|---|---|
| Canonical cache keys | Prevent the same symbol set from generating duplicate cache entries. |
| Separate TTLs | Match LTP, quote, intraday, and historical data to different freshness needs. |
| Global process budget | Count requests across API versions and callers rather than enforcing isolated per-function limits. |
| Safety margins | Keep internal budgets below official quotas. |
| Retry discipline | Retry only bounded transient failures; every retry counts against the request budget. |
| REST fallback | Preserve basic state only when the feed is unavailable; it does not bypass freshness rules. |
| Paper-only boundary | Prevent accidental transition from read-only data access to broker execution. |

Free/public sources such as NSE pages and Yahoo Finance are also treated as unreliable external dependencies. They are cached, sanity-checked, and surfaced as partial or unavailable when needed.

## Repository Layout

```text
Mimir/
├── backend/
│   ├── src/
│   │   ├── analysis/              # features, regime, India context, risk, learning
│   │   ├── intelligence/          # feed connection, orchestrator, candles, workers
│   │   ├── lib/                   # security, Redis, Upstox client, logging, time
│   │   ├── market_data/            # macro, NSE/free data, option chain, ticks
│   │   ├── routes/                 # Express REST routes
│   │   ├── scheduler/              # IST-aware scheduled jobs and locks
│   │   ├── suggestions/            # ingestion, freshness, expectancy, outcomes
│   │   ├── trading/                # paper engine, economics, broker boundary
│   │   ├── ws/                     # WebSocket events and server
│   │   └── index.ts                # process bootstrap and graceful shutdown
│   ├── db/src/schema/              # Drizzle PostgreSQL schemas
│   ├── ai_service/                 # optional FastAPI inference and training code
│   ├── tests/                      # regression, cache, broker-boundary tests
│   ├── build.mjs                   # backend esbuild entrypoint
│   └── package.json
├── frontend/
│   ├── src/components/             # dashboard panels and reusable UI
│   ├── src/hooks/                  # WebSocket and query hooks
│   ├── src/providers/              # market-data and application providers
│   ├── src/pages/                  # dashboard-level pages
│   ├── src/lib/                    # API client, schemas, formatting
│   ├── vite.config.ts              # port 3000 and API/WebSocket proxy
│   └── package.json
├── deploy/                         # hosting notes and deployment assets
├── docs/                           # supporting implementation and testing docs
├── docker-compose.yml              # PostgreSQL, Redis, AI, backend, nginx
├── .env.example                    # environment template
├── ARCHITECTURE_ACTUAL.md          # forensic code-first architecture audit
├── INDIA_SIGNAL_RESEARCH.md        # India-market research and feature contracts
├── MIMIR_SIGNAL_AUDIT.md           # original signal-system audit
├── MIMIR_IMPLEMENTATION_REPORT.md  # broader implementation report
├── MIMIR_SIGNAL_IMPROVEMENT_REPORT.md # latest signal-quality pass
└── README.md                       # this document
```

## Local Development Setup

### Prerequisites

The supported development environment is:

| Requirement | Recommended version |
|---|---|
| Node.js | `22.x` or newer |
| npm | Bundled with Node.js; workspaces are enabled. |
| PostgreSQL | `16.x` or compatible |
| Redis | `7.x` or compatible |
| Python | Required only for the optional AI service and ranker tooling. |
| Upstox credentials | Optional for read-only live market data. |

### Clone and install

```bash
git clone https://github.com/Scifi-ally/Mimir.git
cd Mimir
npm install
```

The backend has a local `.npmrc` compatibility setting for dependency resolution. If the backend is installed independently rather than through the root workspace, use:

```bash
npm --prefix backend install --legacy-peer-deps
```

### Start PostgreSQL and Redis

Create a PostgreSQL database and Redis instance, then set `DATABASE_URL` and `REDIS_URL`. A typical local setup is:

```text
DATABASE_URL=postgresql://mimir:mimir_local_password@127.0.0.1:5432/mimir
REDIS_URL=redis://127.0.0.1:6379
```

The repository also includes Docker Compose definitions for PostgreSQL and Redis; see [Docker Compose](#docker-compose).

### Configure environment

Copy the template and edit it for local paper-only use:

```bash
cp .env.example .env
```

At minimum, configure:

```dotenv
DATABASE_URL=postgresql://mimir:mimir_local_password@127.0.0.1:5432/mimir
REDIS_URL=redis://127.0.0.1:6379
PORT=5000
NODE_ENV=development
PAPER_TRADING_ENABLED=true
TRADING_MODE=PAPER
UPSTOXBOT_SECRET_KEY=replace_with_a_long_random_secret
```

Upstox and AI configuration is optional for a basic local run:

```dotenv
UPSTOX_API_KEY=
UPSTOX_API_SECRET=
UPSTOX_REDIRECT_URI=http://localhost:5000/api/system/auth-callback
AI_SERVICE_URL=http://127.0.0.1:8001
AI_SERVICE_TOKEN=
AI_CORS_ORIGINS=http://localhost:3000,http://localhost:5000
```

For local paper-only development, an admin token is not required by the browser. For any remote or tunnelled access, configure a strong `UPSTOXBOT_ADMIN_TOKEN` and do not disable remote authentication.

### Apply database tables

```bash
npm run setup:db
```

The backend also checks schema compatibility at startup. If startup reports that the Drizzle schema is out of sync, stop the backend, apply migrations/tables, and restart it. Do not bypass the schema check.

### Start the backend

```bash
npm run dev:backend
```

The backend serves:

```text
HTTP API:  http://localhost:5000
Health:    http://localhost:5000/health
Ready:     http://localhost:5000/ready
WebSocket: ws://localhost:5000/ws/intelligence
WebSocket: ws://localhost:5000/ws/market-data
```

### Start the frontend

In a second terminal:

```bash
npm run dev:frontend
```

Open:

```text
http://localhost:3000
```

Vite proxies `/api` and `/ws` to `http://127.0.0.1:5000`, so the browser normally does not need a separate backend origin configuration.

### Start the optional AI service

The AI service is not required for the native fallback path. To use the optional FastAPI service, install its dependencies and start it separately:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r backend/ai_service/requirements.txt
uvicorn main:app --app-dir backend/ai_service --host 127.0.0.1 --port 8001
```

Set the same shared token in the backend and AI-service environments when `AI_SERVICE_TOKEN` is enabled. The backend should continue to run if the AI service is unavailable, but signal records must be interpreted as fallback or partial evidence.

### Run both JavaScript services

The root command can start both development processes:

```bash
npm run dev
```

For troubleshooting and clearer logs, two separate terminals are preferable.

## Docker Compose

`docker-compose.yml` defines PostgreSQL, Redis, the optional AI service, the Node backend, and an nginx frontend container.

```mermaid
graph LR
    PG[(PostgreSQL 16)] --> BE[Backend]
    RD[(Redis 7)] --> BE
    AI[FastAPI AI service] --> BE
    BE --> NG[Nginx frontend]
    Browser --> NG
```

Before starting, provide the required Compose variables:

```dotenv
POSTGRES_PASSWORD=strong_postgres_password
REDIS_PASSWORD=strong_redis_password
UPSTOXBOT_ADMIN_TOKEN=strong_remote_admin_token
UPSTOXBOT_SECRET_KEY=long_stable_secret
AI_SERVICE_TOKEN=shared_ai_service_token
```

Then run:

```bash
docker compose up --build -d
```

The Compose file binds public-facing ports to loopback by default:

| Container | Internal port | Host binding |
|---|---:|---:|
| PostgreSQL | `5432` | `127.0.0.1:5432` |
| Redis | `6379` | Internal network only |
| Backend | `5000` | `127.0.0.1:5000` |
| AI service | `8001` | Internal network only |
| nginx | `80` | `127.0.0.1:3000` |

This is a local/containerized stack, not a claim that the current repository is permanently hosted. A public deployment requires an independently managed persistent host, TLS, remote authentication, secret management, database backups, and operational monitoring.

## HTTP and WebSocket Interfaces

The exact route surface is implemented under `backend/src/routes/`. The following interfaces are the main operator-facing contracts.

| Interface | Purpose |
|---|---|
| `GET /health` | Process liveness. |
| `GET /ready` | PostgreSQL, Redis, and market-feed readiness. |
| `GET /live` | Simple process liveness response. |
| `GET /api/trading/mode` | Permanent paper-only status. |
| `GET /api/suggestions/active` | Active and pending paper suggestions. |
| `GET /api/suggestions/history` | Historical suggestions and outcomes. |
| `GET /api/reports/expectancy` | Net expectancy and performance aggregates. |
| `GET /api/system/status` | Backend, scheduler, feed, database, Redis, and optional-service diagnostics. |
| `GET /api/market/regime` | Current market regime and session state. |
| `GET /api/paper/account` | Paper account state. |
| `GET /api/trading/live/orders` | Permanently disabled; returns HTTP `410`. |
| `GET /api/trading/live/positions` | Permanently disabled; returns HTTP `410`. |
| `GET /api/trading/live/funds` | Permanently disabled; returns HTTP `410`. |
| `WS /ws/intelligence` | Suggestions, alerts, session, and intelligence events. |
| `WS /ws/market-data` | Filtered market ticks and market-data events. |

The browser should use the frontend-origin paths rather than hardcoding backend addresses when running through Vite or nginx.

## Testing and Validation

### JavaScript validation

Run the complete repository checks:

```bash
npm run typecheck
npm run build
npm test
```

Run backend-specific checks:

```bash
cd backend
npm run typecheck
npm run lint
npm test
```

Run frontend-specific checks:

```bash
cd frontend
npm run check
npm run lint
npm test
```

### Additional validation

The repository includes tests for:

| Test family | What it protects |
|---|---|
| Signal generator | Confidence path, ranker gating, fallback behavior, nullable provenance. |
| India market state | Context quality, tradeability, and signal adjustment. |
| Risk regression | Position sizing, hard gates, and market-state behavior. |
| Trade economics | Shared costs, safe sizing, and net P&L. |
| Paper-only boundary | Broker placement refusal and permanently disabled routes. |
| Freshness | Fresh, stale, missing, invalid, and environment-configured timestamps. |
| Cache/Redis | Strict TTL and cache behavior. |
| Intraday monitor | Tick-driven monitoring and derived-state behavior. |
| Ranker parity | TypeScript/Python feature-contract consistency checks where configured. |

Before committing, run:

```bash
git diff --check
```

A successful build or test run does not establish a profitable trading edge. The appropriate research validation is out-of-sample, cost-aware, regime-aware, and based on enough decided paper trades.

## Observability and Troubleshooting

### First checks

```bash
curl -fsS http://localhost:5000/health
curl -fsS http://localhost:5000/ready
curl -fsS http://localhost:5000/api/trading/mode
curl -fsS http://localhost:5000/api/system/status
```

Expected paper-only mode resembles:

```json
{
  "mode": "PAPER",
  "liveActive": false,
  "brokerAuthenticated": false,
  "paperOnly": true
}
```

### Common symptoms

| Symptom | Likely cause | Correct response |
|---|---|---|
| Browser says database is unavailable | PostgreSQL is stopped, `DATABASE_URL` is wrong, or migrations are missing. | Check PostgreSQL, run `npm run setup:db`, then restart. |
| `/ready` reports Redis failure | Redis is stopped or `REDIS_URL` is wrong. | Start Redis and verify `redis-cli ping`. |
| Upstox feed is degraded | Missing/expired read-only credentials, provider outage, or quota protection. | Re-authorize read-only access and inspect status; do not bypass quota controls. |
| AI mode is fallback | AI service is not running, token mismatch, timeout, or model unavailable. | Check AI-service health and token; fallback is expected to remain explicit. |
| WebSocket closes with origin/auth error | Origin is not allowed or remote auth is missing. | Use the configured frontend origin and remote admin token; do not disable remote auth publicly. |
| No suggestions are generated | Market closed, stale inputs, India tradeability failure, weak confidence, insufficient risk/reward, duplicate/capacity limits, or freshness rejection. | Read generation diagnostics and rejection counts rather than weakening gates blindly. |
| Paper P&L differs from a naive price calculation | Brokerage, statutory costs, slippage assumptions, trade type, fill price, or quantity differ. | Use the shared trade-economics output as the source of truth. |
| Startup reports schema out of sync | Database tables do not match Drizzle schema. | Apply migrations/tables and restart; do not ignore the fatal check. |
| Live controls appear in an old browser tab | Stale frontend bundle or cached service worker. | Hard-refresh or clear the local PWA cache and rebuild the frontend. |

### Logs

Backend logs use structured Pino logging. Useful messages include startup security mode, scheduler lifecycle, market-feed state, stale-data warnings, AI circuit-breaker state, paper fills, outcome verification, and safety-gate rejections. Do not log access tokens or copy secrets into issue reports.

## Architecture Trade-offs and Limitations

Mimir is deliberately not a colocated HFT system. It does not provide exchange colocation, FPGA execution, deterministic microsecond latency, a specialized time-series database, or a live-order execution path. PostgreSQL is appropriate for durable application records and moderate historical analysis, while Redis is appropriate for hot state and coordination; neither is a substitute for a high-throughput market-data warehouse.

Free market-data sources have gaps. NSE and public pages can be blocked or delayed. FII/DII data is often published after the session and therefore must be treated as lagged context. Some macro values may be estimates and are flagged accordingly. GIFT Nifty is not treated as a guaranteed live feed; gap-risk logic uses only available free-source inputs.

The optional AI service adds model latency, memory requirements, model-download or artifact management, and feature-contract maintenance. A working AI HTTP response is not automatically a calibrated prediction. Model outputs must be compared with native fallback and evaluated by regime, setup, trade type, and net costs.

The frontend is a browser dashboard. PWA support improves installation and shell caching, but background market intelligence belongs to the backend process and requires PostgreSQL, Redis, and scheduler availability.

## Future Improvement Model

The safest improvement order is empirical rather than feature-count driven.

### First: measure the existing edge

Build a leakage-resistant walk-forward evaluator that preserves the exact feature vector, decision timestamp, market state, costs, capacity, fill status, and data-quality state for each paper signal. Report net expectancy, profit factor, drawdown, calibration error, turnover, and sample counts by setup, regime, direction, trade type, and provenance path.

### Second: close feature-contract drift

Keep TypeScript live features, Python training features, ranker model artifacts, and tests under one versioned feature contract. A model should be rejected at startup or inference time if its expected feature names, order, or dimensionality do not match the live producer.

### Third: improve data availability semantics

Add explicit `availableAt`, `sourceTimestamp`, `ageSeconds`, and `quality` fields to global macro, options, breadth, and institutional-flow state. A feature should be excluded or a signal family paused when its data is too stale, rather than silently retaining an old value without a visible age.

### Fourth: improve paper-fill realism

Record quote-side availability, spread, expected slippage, latency from signal to fill, partial-fill assumptions, and the reason a pending signal became active or expired. Do not add more predictive features until the outcome labels accurately represent what a real paper order would have experienced.

### Fifth: keep the safety boundary permanent

Any future feature work must preserve paper-only execution, free/read-only source constraints, Upstox quota budgets, freshness gates, and cost-aware reporting. A higher signal count is not an improvement if it reduces evidence quality or increases false confidence.

## References

[1]: https://upstox.com/developer/api-documentation/rate-limiting/ "Upstox API rate limiting documentation"

[2]: https://www.sebi.gov.in/reports-and-statistics/research/jul-2025/comparative-study-of-growth-in-equity-derivatives-segment-vis-vis-cash-market-after-recent-measures_95105.html "SEBI comparative study of the equity-derivatives segment, July 2025"

[3]: https://www.aqr.com/Insights/Research/White-Papers/Transactions-Costs-Practical-Application "AQR: Transaction Costs — Practical Application"

[4]: https://arxiv.org/abs/2512.12924 "Leakage-resistant walk-forward validation research"

## License

Mimir is distributed under the MIT License. See [LICENSE](LICENSE).
