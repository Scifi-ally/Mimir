# Mimir

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)

Mimir is an advanced, AI-assisted Indian stock market monitoring and automated trading analysis platform. Engineered for low-latency market data ingestion and real-time decision support, it combines a robust Node.js/TypeScript backend, a high-performance React dashboard, and a dedicated Python FastAPI intelligence engine.

---

## Dashboard Preview

![Mimir Real-Time Dashboard](docs/dashboard.png)

---

## Key Highlights

*   **Real-Time Market Telemetry**: Ingests live NSE/BSE market feeds and tick distributions via high-speed WebSockets, delivering sub-second updates to the client.
*   **AI Alpha Factors & Predictive Modeling**: Dedicated Python intelligence engine evaluating multi-timeframe momentum, volume surges, and regime alignment to generate composite alpha scores.
*   **Custom Screener & Rule Engine**: Interactive advanced rule builder allowing complex conditional scanning across price action, technical indicators, and institutional flow metrics.
*   **Institutional Flow Tracking**: Integrated real-time monitoring of Foreign Institutional Investors (FII) and Domestic Institutional Investors (DII) net cash flows.
*   **Paper Trading & Risk Management**: Built-in simulation engine featuring automated stop-loss trailing, daily loss thresholds, and strict capital exposure limits.

## System Architecture

The platform operates as a decoupled, multi-service architecture designed for resilience and horizontal scalability:

1.  **Backend API (Express / TypeScript)**: Handles Upstox OAuth2 authentication, WebSocket connection pooling, order management, and system telemetry.
2.  **Intelligence Service (Python / FastAPI)**: Executes heavy numerical calculations, sentiment evaluations, and automated signal generation without blocking the primary I/O thread.
3.  **Frontend Interface (React / Vite / Tailwind CSS)**: A state-of-the-art, dark-mode trading interface utilizing custom canvas charting, sparklines, and dynamic notification drawers.
4.  **Persistence Layer (PostgreSQL & Redis)**: Relational storage for historical market data, user watchlists, and audit logs, paired with Redis for high-speed state caching.

## Security & Safety Defaults

*   **Restricted Access**: Remote backend API access is disabled by default unless explicitly authenticated via `UPSTOXBOT_ADMIN_TOKEN`.
*   **Rate Limiting**: Public API endpoints enforce strict token-bucket rate limiting (120 requests per minute) to prevent Denial of Service (DoS) and API abuse.
*   **CORS Hardening**: Cross-Origin Resource Sharing is strictly restricted to verified local and production origins via `AI_CORS_ORIGINS`.
*   **Zero Hardcoded Secrets**: All credentials and API tokens are dynamically managed via environment variables and encrypted database schemas.

## Getting Started

### Prerequisites

*   Node.js (v22.0 or higher)
*   Python (v3.12 or higher)
*   PostgreSQL (v16.0 or higher)

### Environment Setup

1.  Clone the repository and duplicate the environment template:
    ```bash
    cp .env.example .env
    ```
2.  Configure your database connection string and Upstox API credentials in `.env`.

### Installation

Install dependencies across all system components:

```bash
# Install root and backend dependencies
npm install
npm --prefix backend install --legacy-peer-deps

# Install Python AI service dependencies
pip install -r backend/ai_service/requirements.txt
```

### Database Initialization

Run automated database schema migrations and table setup:

```bash
npm run setup:db
```

### Running Locally

Launch the application services in development mode:

```bash
# Terminal 1: Start the Express Backend API
npm run dev:backend

# Terminal 2: Start the Python Intelligence Service
uvicorn main:app --app-dir backend/ai_service --host 0.0.0.0 --port 8001
```

*   **Backend API**: Access at `http://localhost:5000`
*   **AI Service**: Access at `http://localhost:8001`

## Docker Deployment

To launch the entire stack in an isolated containerized environment:

```bash
docker compose up --build -d
```

## Quality Assurance & Testing

Run the automated test suites and type validation before deploying:

```bash
npm run typecheck
npm test
npm run build
```

---
*Developed with a focus on institutional-grade execution safety and real-time market transparency.*
