# Mimir Architecture Documentation

Mimir is an advanced algorithmic trading terminal and market intelligence scanner built for the NSE/BSE markets. It ingests real-time market ticks, performs technical and machine-learning-based analysis, and executes algorithmic paper/live trades while broadcasting opportunities to the frontend via WebSockets.

## 1. High-Level System Architecture

**Tech Stack:**
*   **Backend:** Node.js, TypeScript, `node:events`, `worker_threads`, Redis, PostgreSQL (Drizzle ORM).
*   **AI Service:** Python, FastAPI, HuggingFace Transformers, PyTorch, XGBoost.
*   **Frontend Data:** WebSockets for real-time updates, Redis for fast hydration.

```mermaid
graph TD
    subgraph Data Ingestion
        A[Upstox WebSocket] -->|Raw Ticks| B(Tick Distribution Server)
        B -->|UI Batch Stream| C(WebSocket Broadcaster)
        B -->|processedTick| D(Tick Engine)
    end

    subgraph Orchestration & Event Bus
        D -->|marketTick / candleClosed| E{Intelligence Bus}
        E --> F[Scanner Orchestrator]
    end

    subgraph Signal Generation Pipeline
        F -->|Evaluate| G[Signal Generator]
        G -->|Assemble| H[Feature Engine]
        G <-->|Offload| I[Worker Pools]
    end

    subgraph Intelligence/ML Layer (FastAPI)
        H --> J[Chronos-Bolt-Small]
        H --> K[FinBERT Sentiment]
        H --> L[XGBoost Ranker]
    end

    subgraph Execution
        G -->|suggestionTriggered| M[Paper / Live Engine]
        M --> N[(PostgreSQL)]
    end
```

---

## 2. Data Ingestion & Distribution

The entry point for all real-time market data is the **Tick Distribution Server** (`tick_distribution.ts`) and the **Tick Engine** (`tick_engine.ts`).

*   **Tick Distribution (`tick_distribution.ts`):** 
    *   Acts as a decoupler between raw WebSocket ingestion and UI streaming.
    *   Maintains an O(1) in-memory cache of normalized ticks.
    *   Drops out-of-sequence ticks and normalizes prices, volume, and OI.
    *   **UI Streaming:** Buffers ticks and flushes them to connected WebSocket clients in millisecond-scale batches (e.g., 30-60 FPS) to avoid overwhelming the browser.
    *   **Analysis Dispatch:** Publishes `processedTick` events to the Intelligence Bus asynchronously without blocking the event loop.
*   **Tick Engine (`tick_engine.ts`):**
    *   Listens to `processedTick`.
    *   Maintains real-time state for indicators (LTP, VWAP, Day High/Low).
    *   Generates OHLCV candles dynamically.
    *   Fires `marketTick` and `candleClosed` events to trigger downstream analysis.

---

## 3. Orchestration & Event Bus

Mimir relies on a central `EventEmitter`-based bus (`intelligenceBus` in `event_bus.ts`) to loosely couple its subsystems.

*   **Scanner Orchestrator (`orchestrator.ts`):** The brain of the application. It listens to `marketTick` events and orchestrates the analytical pipeline.
    *   **Scheduled Scans:** Runs exhaustive full-market scans on a 5-minute cron.
    *   **Real-time Scans:** Debounces fast-moving ticks (e.g., every 2 seconds) to evaluate real-time signals alongside the scheduled scans.
*   **Concurrency & Backpressure:** The `EventEmitter` bus does not natively handle backpressure. To prevent CPU lockup, heavy technical analysis and AI batch preparation are delegated to **Thread Worker Pools** (`worker_pool.ts`). These pools have strict queue limits (e.g., 2000). If the limit is breached, new tasks are immediately rejected (Dynamic Backpressure), ensuring the main Node thread remains responsive.

---

## 4. Signal Generation Pipeline

The `signal_generator.ts` is the central hub where technical setups meet AI ranking. 

1.  **Technical Screening:** The orchestrator identifies technical candidate setups (e.g., breakouts, mean reversions).
2.  **Feature Assembly (`feature_engine.ts`):** For each candidate, a `FeatureVector` is computed. This includes:
    *   Price momentum, RSI, MACD.
    *   Real-time F&O data (Bid-Ask Imbalance, Options OI Change Rate).
    *   Macro regime indicators and FII/DII flow lag.
3.  **Fail-Loud Data Policy:** If real-time features (like F&O data) are missing or stale (older than 60 seconds), the system sets a `rankerIncomplete` flag. This intentionally aborts the signal generation to prevent the AI from generating predictions based on garbage or default data.
4.  **AI Offloading:** Complete feature vectors are sent to the Python AI service for scoring.

---

## 5. Intelligence & AI Layer

The Python AI service (FastAPI) provides the predictive edge.

*   **Chronos-Bolt-Small (`amazon/chronos-bolt-small`):** A lightweight time-series forecasting model. It predicts the probabilistic price trajectory based strictly on the sequence of closing prices.
*   **FinBERT Sentiment (`ProsusAI/finbert`):** Evaluates news headlines and macroeconomic keywords to produce a sentiment score (-1.0 to 1.0). Due to HuggingFace pipeline thread-safety constraints, this runs serially under a `_pipeline_call_lock`.
*   **XGBoost Learned Ranker:** A classical ML model trained on historical setups. It consumes the `FeatureVector` to predict the probability of hitting the target before the stop-loss (`P(target1 before stop)`).
*   **Rule-Based Regime Detection:** Determines the overarching market environment (e.g., Bullish, Volatile, Bearish) using technical breadth and stochastic heuristics.

---

## 6. Execution: Paper & Live Trading

When a signal exceeds the required AI confidence thresholds, a `suggestionTriggered` event is fired and intercepted by the `paper_engine.ts`.

*   **Point-in-Time Execution:** The engine executes entries using the *current* Last Traded Price (LTP) pulled synchronously from the `stateStore`. It applies a **missed fill guard**: if the market price has slipped >0.5% away from the original theoretical entry, the trade is rejected. This prevents the backtester from recording "perfect" fills during violent gap-ups.
*   **Dynamic Position Sizing:** Risk is dynamically scaled based on the AI confidence and empirical win rates (Quarter-Kelly criterion), hard-capped at 2% risk per trade.
*   **Margin & Concurrency:** Postgres row-level locking (`FOR UPDATE`) is used to prevent race conditions when multiple signals attempt to allocate margin simultaneously.
*   **Circuit Limit Detection:** Detects prolonged zero-volume or absent bid/ask scenarios to prevent forced exits at absurd slippage during temporary feed degradation.
*   **Live Mode:** In live mode, the exact same simulated book is maintained, but every fill is mirrored via API calls to the actual broker (`broker_orders.ts`).

---

## 7. Frontend Integration

*   **Suggestions Cache:** Active trade suggestions are cached in Redis. When a user opens the frontend, it instantly hydrates from Redis rather than waiting for the next market tick.
*   **WebSocket Broadcasts:** The backend flushes a `marketIntelligenceUpdate` payload containing live PnL, active suggestions, and market breadth to the React frontend.
*   **Diagnostic Telemetry:** Internal system health (feed latency, dropped ticks, batch queue size) is continuously tracked and available for monitoring.
