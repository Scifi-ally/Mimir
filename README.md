<div style="font-family: 'Geist Mono', monospace;">

# Mimir

<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![License MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)
[![CI Status](https://img.shields.io/github/actions/workflow/status/Scifi-ally/Mimir/ci.yml?branch=master&style=for-the-badge)](https://github.com/Scifi-ally/Mimir/actions)

**A Production-Ready Algorithmic Trading Engine for the Indian Stock Market.**

[Key Features](#key-features) • [System Architecture](#system-architecture) • [Getting Started](#getting-started) • [Security Standards](#security--safety-defaults) • [Contributing](CONTRIBUTING.md)

---

</div>

## Dashboard Preview

<div align="center">
  <img src="docs/smooth.gif" alt="Mimir Real-Time Trading Dashboard" width="100%" style="border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,0.5);" />
</div>

---

## Overview

Mimir is an advanced algorithmic trading terminal and market intelligence scanner built for the NSE/BSE markets. It ingests real-time market ticks, performs technical and machine-learning-based analysis, and executes algorithmic paper/live trades while broadcasting opportunities to the frontend via WebSockets.

Key service capabilities include:

1. **WebSocket Telemetry**: Ultra-low latency streaming of tick distributions, market depth, and real-time PnL.
2. **AI Intelligence Engine**: A Python FastAPI microservice integrating time-series forecasting (Chronos-Bolt-Small), news sentiment analysis (FinBERT), and a learned ranker model for setup scoring.
3. **Event-Driven Microarchitecture**: Decoupled Node.js/TypeScript backend utilizing `worker_threads` for non-blocking analysis, coupled with PostgreSQL + Redis state persistence.

---

## Key Features

### Market Telemetry & Charting
* **Canvas Charting**: Rendered via TradingView lightweight-charts, supporting EMA, VWAP, Support/Resistance zones, and price projection overlays.
* **Tick-by-Tick Order Book**: Live market depth monitoring and tick distribution analysis.

### Advanced Quantitative Modules
* **Divergence Engine**: Automated detection of RSI and MACD divergences against price action.
* **Order Flow Analysis**: Deep evaluation of institutional accumulation and distribution phases.
* **Fundamental & Alpha Health Tracking**: Integration of structural health and institutional flow schemas.

### Custom Screener & Rule Engine
* **Interactive Rule Builder**: Construct conditional scanning rules across price action and technical indicators.
* **Background Scanning**: Thread worker pools continuously evaluate active symbols against screener conditions.

### Risk Management
* **Paper & Live Trading Engines**: Test quantitative strategies in live market conditions with point-in-time fill simulation and live broker execution.
* **Automated Risk Guardrails**: Built-in automated stop-loss trailing, slippage guards, and daily loss thresholds.

---

## System Architecture

Mimir is a decoupled, event-driven system: a Node/TypeScript backend that owns the market-data feed and trading engines, a Python FastAPI microservice for model inference, PostgreSQL + Redis for persistence and hot state, and a React dashboard fed over binary WebSockets.

### High-Level System Architecture

* **Backend**: Node.js, TypeScript, `node:events`, `worker_threads`, Redis, PostgreSQL (Drizzle ORM).
* **AI Service**: Python, FastAPI, HuggingFace Transformers, PyTorch, XGBoost / LightGBM.
* **Frontend Data**: WebSockets for real-time updates, Redis for fast hydration.

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
        H --> L[XGBoost / LightGBM Ranker]
    end

    subgraph Execution
        G -->|suggestionTriggered| M[Paper / Live Engine]
        M --> N[(PostgreSQL)]
    end
```

### 1. Data Ingestion & Distribution

The entry point for all real-time market data is the **Tick Distribution Server** (`tick_distribution.ts`) and the **Tick Engine** (`tick_engine.ts`).

* **Tick Distribution (`tick_distribution.ts`):** 
    * Acts as a decoupler between raw WebSocket ingestion and UI streaming.
    * Maintains an O(1) in-memory cache of normalized ticks.
    * Drops out-of-sequence ticks and normalizes prices, volume, and OI.
    * **UI Streaming:** Buffers ticks and flushes them to connected WebSocket clients in millisecond-scale batches (e.g., 30-60 FPS) to avoid overwhelming the browser.
    * **Analysis Dispatch:** Publishes `processedTick` events to the Intelligence Bus asynchronously without blocking the event loop.
* **Tick Engine (`tick_engine.ts`):**
    * Listens to `processedTick`.
    * Maintains real-time state for indicators (LTP, VWAP, Day High/Low).
    * Generates OHLCV candles dynamically.
    * Fires `marketTick` and `candleClosed` events to trigger downstream analysis.

---

### 2. Orchestration & Event Bus

Mimir relies on a central `EventEmitter`-based bus (`intelligenceBus` in `event_bus.ts`) to loosely couple its subsystems.

* **Scanner Orchestrator (`orchestrator.ts`):** The brain of the application. It listens to `marketTick` events and orchestrates the analytical pipeline.
    * **Scheduled Scans:** Runs exhaustive full-market scans on a 5-minute cron.
    * **Real-time Scans:** Debounces fast-moving ticks (e.g., every 2 seconds) to evaluate real-time signals alongside scheduled scans.
* **Concurrency & Backpressure:** The `EventEmitter` bus does not natively handle backpressure. To prevent CPU lockup, heavy technical analysis and AI batch preparation are delegated to **Thread Worker Pools** (`worker_pool.ts`). These pools have strict queue limits (e.g., 2000). If the limit is breached, new tasks are immediately rejected (Dynamic Backpressure), ensuring the main Node thread remains responsive.

---

### 3. Signal Generation Pipeline

The `signal_generator.ts` is the central hub where technical setups meet AI ranking.

1. **Technical Screening:** The orchestrator identifies technical candidate setups (e.g., breakouts, mean reversions).
2. **Feature Assembly (`feature_engine.ts`):** For each candidate, a `FeatureVector` is computed. This includes:
    * Price momentum, RSI, MACD.
    * Real-time F&O data (Bid-Ask Imbalance, Options OI Change Rate).
    * Macro regime indicators and FII/DII flow lag.
3. **Fail-Loud Data Policy:** If real-time features (like F&O data) are missing or stale (older than 60 seconds), the system sets a `rankerIncomplete` flag. This intentionally aborts signal generation to prevent the AI from generating predictions based on garbage or default data.
4. **AI Offloading:** Complete feature vectors are sent to the Python AI service for scoring.

---

### 4. Intelligence & AI Layer

The Python AI service (FastAPI) provides the predictive edge:

| Model | Role |
|---|---|
| **Chronos-Bolt-Small** (`amazon/chronos-bolt-small`) | A lightweight time-series forecasting model predicting probabilistic price trajectory based on closing price sequences. |
| **FinBERT Sentiment** (`ProsusAI/finbert`) | Evaluates news headlines and macroeconomic keywords to produce a sentiment score (-1.0 to 1.0) under a `_pipeline_call_lock`. |
| **Learned Ranker** | A machine-learning model trained on historical setups. Consumes the `FeatureVector` to predict target hit probability before stop-loss. |
| **Rule-Based Regime Detection** | Determines the overarching market environment (e.g., Bullish, Volatile, Bearish) using technical breadth and stochastic heuristics. |

---

### 5. Execution: Paper & Live Trading

When a signal exceeds the required AI confidence thresholds, a `suggestionTriggered` event is fired and intercepted by `paper_engine.ts`.

* **Point-in-Time Execution:** The engine executes entries using the *current* Last Traded Price (LTP) pulled synchronously from `stateStore`. It applies a **missed fill guard**: if the market price has slipped >0.5% away from the original theoretical entry, the trade is rejected.
* **Dynamic Position Sizing:** Risk is dynamically scaled based on AI confidence and empirical win rates (Quarter-Kelly criterion), hard-capped at 2% risk per trade.
* **Margin & Concurrency:** Postgres row-level locking (`FOR UPDATE`) prevents race conditions when multiple signals attempt to allocate margin simultaneously.
* **Circuit Limit Detection:** Detects prolonged zero-volume or absent bid/ask scenarios to prevent forced exits at absurd slippage during feed degradation.
* **Live Mode:** Every fill in live mode is mirrored via API calls to the actual broker (`broker_orders.ts`).

---

### 6. Frontend Integration & Telemetry

* **Suggestions Cache:** Active trade suggestions are cached in Redis. When a user opens the frontend, it instantly hydrates from Redis.
* **WebSocket Broadcasts:** The backend flushes a `marketIntelligenceUpdate` payload containing live PnL, active suggestions, and market breadth to the React frontend.
* **Diagnostic Telemetry:** Internal system health (feed latency, dropped ticks, batch queue size) is continuously tracked and monitored.

---

### Ports

| Port | Service |
|---|---|
| 3000 | Frontend (React / Vite preview) |
| 5000 | Backend API + trading engine + WebSockets |
| 5433 | PostgreSQL (portable install; Docker uses 5432) |
| 6379 | Redis |
| 8001 | AI microservice (localhost-bound) |

---

## Security & Safety Defaults

* **Restricted Admin Access**: Remote backend API access is disabled by default unless explicitly authenticated via `UPSTOXBOT_ADMIN_TOKEN`.
* **Rate Limiting**: Public API endpoints enforce token-bucket rate limiting (100 requests per minute for standard APIs, 10 requests per minute for authentication endpoints).
* **CORS Hardening**: Cross-Origin Resource Sharing is strictly restricted to verified local and production origins via `AI_CORS_ORIGINS`.
* **Zero Hardcoded Secrets**: Credentials, Upstox OAuth tokens, and API secrets are managed via environment variables and encrypted database schemas.

---

## Remote Access & Cloudflare Tunnels

Mimir is designed to execute locally. If deployment requires exposure to the public internet (e.g., via Cloudflare Tunnels), rigorous authentication protocols must be configured to secure data and Upstox API credentials.

1. Define the `UPSTOXBOT_ADMIN_TOKEN` environment variable in the `.env` file as a cryptographically secure string.
2. The WebSocket telemetry and REST API endpoints will automatically enforce this token for external connections.
3. In the frontend environment, authenticate by persisting this token in browser local storage: `localStorage.setItem('mimir_admin_token', 'your_secure_token')`.
4. **Tunnel Opt-In**: The `bot.bat` launcher does not initiate the Cloudflare tunnel by default. To start the tunnel, explicitly execute `bot.bat tunnel <port>`.

---

## Hardware Requirements

* **Minimum Requirements**: 4GB RAM, Dual-Core CPU (Intel i3 / AMD Ryzen 3 or equivalent), Windows 10/11 (for the portable setup).
* **AI Service (Optional but Recommended)**: The AI service runs heavily on the CPU if a dedicated GPU is not present. For laptops with low hardware specs, startup might take 1-2 minutes longer as models load into memory. The system is configured to gracefully run offline without pinging HuggingFace (`HF_HUB_OFFLINE=1`), making it perfectly fine for standard laptops.

---

## 🚀 Portable Windows Setup (1-Click Quickstart)

If you are on Windows, you **do not** need to install Node.js, Python, PostgreSQL, or Redis manually! You can use our zero-dependency portable installer:

1. Clone or download this repository.
2. Double-click the **`setup.bat`** file in the root folder.
3. The script will automatically download and configure all necessary dependencies (`.portable` folder), initialize the database, and install npm packages.
4. Once finished, run **`bot.bat start`** to boot the entire system!

---

## Developer Manual Setup

### Prerequisites
* **Node.js** (v22.0 or higher)
* **Python** (v3.12 or higher)
* **PostgreSQL** (v16.0 or higher)
* **Redis** (v7.0 or higher - optional, defaults to in-memory fallback)

### 1. Environment Setup
Clone the repository and duplicate the environment template:
```bash
git clone https://github.com/Scifi-ally/Mimir.git
cd Mimir
cp .env.example .env
```
Configure your PostgreSQL database connection string and Upstox API credentials in `.env`.

### 2. Installation
Install dependencies across all system components:
```bash
# Install root and backend dependencies
npm install
npm --prefix backend install --legacy-peer-deps

# Install Python AI service dependencies
pip install -r backend/ai_service/requirements.txt
```

### 3. Database Initialization
Run automated database schema migrations and table setup:
```bash
npm run setup:db
```

### 4. Running Locally
Launch the application services in development mode:
```bash
# Terminal 1: Start the Express Backend API
npm run dev:backend

# Terminal 2: Start the Python Intelligence Service
uvicorn main:app --app-dir backend/ai_service --host 127.0.0.1 --port 8001

# Terminal 3: Start the React Frontend Dashboard
npm --prefix frontend run dev
```

* **Frontend Dashboard**: `http://localhost:3000` (or `5173`)
* **Backend API**: `http://localhost:5000`
* **AI Service**: `http://localhost:8001`

---

## Windows One-Click Launch (`bot.bat`)

For Windows environments, Mimir includes an automated launcher that manages background process spawning and port verification:
```cmd
bot.bat
```
To start the application and automatically open an opt-in Cloudflare tunnel:
```cmd
bot.bat tunnel 3000
```
To terminate all running services and tunnels cleanly:
```cmd
bot.bat stop
```

---

## Docker Deployment

To initialize the entire stack (Frontend, Backend, AI Engine, PostgreSQL, and Redis) within isolated containerized environments:
```bash
docker compose up --build -d
```

---

## Quality Assurance & Testing

Execute the automated test suites and static type validation prior to deployment:
```bash
npm run typecheck
npm test
npm run build
```

---

## Contributing & Community

Contributions are encouraged from developers, quantitative analysts, and open-source enthusiasts.
* Please review the [Contributing Guidelines](CONTRIBUTING.md) for details on setting up your environment and submitting Pull Requests.
* Please adhere to the [Code of Conduct](CODE_OF_CONDUCT.md) in all community interactions.

## License

This project is open-source and licensed under the terms of the [MIT License](LICENSE).

---

## Known Architectural Limitations

While this platform offers robust retail-level monitoring and analysis, it is necessary to acknowledge its architectural limits. **This system is a retail-level setup masquerading as an institutional platform.** True High-Frequency Trading (HFT) and institutional operations require infrastructure that Mimir fundamentally lacks:

1. **Tick-Level Storage**: The current PostgreSQL architecture is entirely unsuited for storing or querying true HFT tick-level data at scale.
2. **Time-Series Processing**: Redis is utilized strictly for volatile state caching and rate limiting, not as a high-performance time-series database. 
3. **Hardware & Infrastructure**: A strict institutional setup demands specialized time-series databases (e.g., TimescaleDB or KDB+), network colocation services, and FPGA hardware for sub-millisecond execution—none of which are provided by this architecture.

</div>