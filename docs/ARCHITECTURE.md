# Mimir Architecture Documentation

## 1. System Overview

Mimir is an algorithmic trading terminal and market intelligence scanner built for the NSE/BSE markets. It ingests real-time market ticks, performs technical and machine-learning-based analysis, and broadcasts qualified trading opportunities to the frontend via WebSockets. The system is split across a Node.js (TypeScript) primary backend and a Python (FastAPI) AI inference service.

**Tech Stack:**
*   **Backend:** Node.js, TypeScript, `node:events`, `worker_threads`, Redis, PostgreSQL (Drizzle ORM).
*   **AI Service:** Python, FastAPI, HuggingFace Transformers, PyTorch.
*   **Frontend Data:** WebSockets for real-time updates, Redis for fast hydration.

**High-Level Architecture (Mermaid):**
```mermaid
graph TD
    subgraph Data Layer
        A[Upstox WebSocket] -->|Ticks| B(Tick Feeder)
        B -->|Redis Batch 1s| C(Tick Engine)
        D[FII/DII & Macro Data] --> C
    end

    subgraph Orchestration & Event Bus
        C -->|processedTick| E{Intelligence Bus}
        E -->|candidateCreated| F[Candidate Detection Pool]
        F -->|opportunityQualified| G[Technical Analysis Pool]
        G --> H[AI Ranking Pool]
    end

    subgraph Intelligence/ML Layer (FastAPI)
        H <-->|HTTP Batch Request| I[Chronos-T5]
        H <-->|HTTP Request| J[FinBERT Sentiment]
        H <-->|HTTP Request| K[RL Agent / Ranker]
    end

    subgraph API & Frontend
        H --> L(Suggestion Generator)
        L --> M[Redis Cache]
        L --> N[WebSocket Broadcaster]
        N --> O[Frontend Client]
    end
```

## 2. Data Layer

The Data Layer is responsible for ingesting, transforming, and buffering market data to feed the analytical engines.

*   **Upstox WebSocket Live Feed:** Ingests live tick data via `tick_feeder.ts`. Due to high throughput, ticks are batched using Redis pipelines and flushed every 1 second to minimize I/O overhead.
*   **F&O / Options Data:** Extracted via `fetchOptionChainData`. Provides PCR (Put-Call Ratio) data used as a confidence multiplier in technical rankings.
*   **FII/DII Inputs:** Fetched via `fetchFIIDIIData`. Extreme institutional buying/selling (> ±2000 Cr) applies significant boosts or penalties to a symbol's technical score.
*   **Macro Inputs:** `getGlobalMacroState` provides an `eventRiskActive` flag to universally penalize trade probabilities during major global risks.
*   **Refresh/Latency:** Live ticks are processed in near-real-time. Analytical pipelines use throttled evaluation (e.g., candidate detection is limited to once every 2 seconds per symbol) to avoid processing avalanches.

## 3. Intelligence/ML Layer

The AI/ML pipeline evaluates technically qualified candidates to produce a composite AI score. The models are served via a FastAPI Python microservice.

*   **Chronos-T5 (`amazon/chronos-bolt-small`):** A time-series forecasting model generating probabilistic price trajectories based strictly on close prices.
    *   *Inputs:* Univariate time-series (Close prices).
    *   *Outputs:* Median forecast, quantiles (q10, q25, q75, q90), and predicted trend direction.
    *   *Limitations:* Being a univariate T5 transformer model, it completely ignores volume, OHLC structure, and external regressors. It also lacks SHAP explainability.
*   **FinBERT Sentiment Gating (`ProsusAI/finbert`):** Evaluates news headlines and produces a sentiment score (-1.0 to 1.0).
    *   *Chaining:* Blended heavily with geopolitical keyword heuristics to map political and world events to Indian market impacts. Results are cached (300s TTL) and weighted into the composite score.
*   **RL Agent:** An experimental reinforcement learning agent that evaluates macro state (VIX, PCR, FII Net) and OHLCV data to output a confidence adjustment (boost/penalty).
*   **XGBoost Learned Ranker:** Provides a calibrated probability `P(target1 before stop)`.
*   **HMM Regime Detection:** *Planned but not built.* The system currently passes a hardcoded/heuristic `regime` placeholder.

## 4. Signal & Event Bus

The core orchestration relies on an internal `EventEmitter`-based bus (`intelligenceBus` in `event_bus.ts`).

*   **Message Types:** `processedTick`, `candleClosed`, `candidateCreated`, `opportunityQualified`, `suggestionGenerated`, `breadthUpdated`, `universeUpdated`.
*   **Publishers:** `ScannerOrchestrator` (publishes events as market data updates state) and `TickEngine`.
*   **Subscribers:** The orchestrator itself subscribes to bus events to delegate tasks to the worker pools.
*   **Backpressure Handling (Gap):** The `EventEmitter` bus *does not natively handle backpressure*. When the bus broadcasts `processedTick`, consumers synchronously fire promises. While the downstream Node.js worker pools implement dynamic backpressure (rejecting tasks when queues are full), the bus itself lacks flow control, leading to potential event saturation and discarded tasks under heavy volatility.

## 5. Execution/Worker Layer

To prevent CPU blocking on the main Node.js thread, heavy technical analysis and AI batch preparation are delegated to a Thread Worker Pool (`worker_pool.ts` using `node:worker_threads`).

*   **Concurrency Model:** Multiple specific pools (e.g., `candidateDetection`, `technicalAnalysis`, `aiRanking`) isolate workloads.
*   **Queuing System:** Each pool has a strict `maxQueueSize` (e.g., 2000). If the queue limit is breached, new tasks are immediately rejected (*Dynamic Backpressure*).
*   **Lifecycle & Failure Recovery:** Workers emit health pings. If a worker fails, it is automatically respawned. The system detects "spawn loops" (e.g., 5 rapid consecutive crashes) and halts respawns to prevent total CPU lockup.
*   **Python (FastAPI) Backend:** The actual AI inference runs out-of-process in a Python service. The Node workers bundle candidates and execute batched HTTP requests. The Python service uses background threads to eagerly load models, ensuring `/health` probes don't time out during startup.

## 6. API & Frontend

*   **Suggestion Generator:** Rather than bubbling raw `opportunityQualified` events directly to the frontend, the `SuggestionGenerator` manages the lifecycle of an active signal. It maintains an active set in memory, assigning expiration times (default 20 mins for intraday, up to 5 days for swing trades) and filtering out redundant signals.
*   **Redis Caching:** Valid suggestions are serialized and cached in Redis. When the frontend connects, it can instantly hydrate its state from Redis without waiting for the next market tick to trigger an evaluation.
*   **WebSocket Distribution:** A dedicated flush timer in the orchestrator runs frequently (typically every 1000ms), broadcasting a `marketIntelligenceUpdate` over WebSockets containing the system snapshot, active suggestions, and market breadth.

## 7. Infrastructure & Deployment

*   **Backend:** Node.js instance running the orchestrator and WebSocket server.
*   **AI Service:** FastAPI Python application exposed on port 8001.
*   **Database:** PostgreSQL (via Drizzle ORM) for long-term historical records (custom screener runs, fundamental snapshots, sentiment data).
*   **Cache/Message Broker:** Redis for caching states, frontend payloads, and inter-process tick batching.

## 8. Known Gaps / Technical Debt

1.  **HMM Regime Detection:** Mentioned in roadmap/planning discussions, but there is no Hidden Markov Model implementation in the codebase. Market regimes are currently derived using simple technical breadth or stochastic heuristics.
2.  **Event Bus Backpressure:** The `intelligenceBus` broadcasts indiscriminately. While worker pools reject overflowing tasks, the main thread can still suffer from event loop lag during massive tick influxes because the `EventEmitter` doesn't pause the upstream publisher.
3.  **Chronos Explainability:** `amazon/chronos-bolt-small` offers zero SHAP or feature-importance explainability, rendering AI scoring partially a "black box" to the end user.
4.  **FinBERT Synchronous Bottlenecks:** HuggingFace `pipeline` Fast Tokenizers are not thread-safe under concurrent `__call__`. The Python service employs a `_pipeline_call_lock` to serialize execution, establishing a severe bottleneck during batch sentiment evaluation.
