# Mimir

Mimir is an advanced, AI-assisted Indian stock market monitoring and analysis platform. It features an Express and TypeScript backend, a modern React and Vite frontend, a FastAPI-powered AI analysis service, and PostgreSQL for robust data storage.

## Architecture

*   **Backend API**: Built with Node.js, Express, and TypeScript. Handles data ingestion, authentication, and core business logic.
*   **Frontend**: A responsive, high-performance dashboard built with React, Vite, and Tailwind CSS.
*   **AI Service**: A Python-based FastAPI service leveraging state-of-the-art models for market sentiment analysis and predictive modeling.
*   **Database**: PostgreSQL for storing historical market data, user configurations, and trading suggestions.

## Security Overview

*   **Restricted Access**: Remote backend API access is disabled by default unless the `UPSTOXBOT_ADMIN_TOKEN` environment variable is explicitly configured.
*   **Secure Defaults**: The provided `.env.example` file mandates manual configuration of admin tokens to prevent the deployment of insecure placeholders.
*   **Rate Limiting**: Non-local `/api` endpoints are strictly rate-limited to 120 requests per minute to mitigate abuse.
*   **CORS Policies**: AI service Cross-Origin Resource Sharing (CORS) is restricted to configured and local origins via the `AI_CORS_ORIGINS` variable.
*   **Strict Configuration**: Trading configurations loaded from the database are strictly enforced at startup.

## Local Environment Setup

### Prerequisites

Ensure the following dependencies are installed on your system:
*   Node.js (v22 or higher)
*   Python (v3.12 or higher)
*   PostgreSQL (v16 or higher)

### Configuration

1.  Copy the example environment configuration:
    ```bash
    cp .env.example .env
    ```
2.  Populate the `.env` file with your `DATABASE_URL`, Upstox API credentials, `UPSTOXBOT_SECRET_KEY`, and a strong `UPSTOXBOT_ADMIN_TOKEN` if remote client access is required.

### Installation

Install all required dependencies for the backend, frontend, and AI service:

```bash
npm install
npm --prefix backend install --legacy-peer-deps
pip install -r backend/ai_service/requirements.txt
```

### Database Initialization

Prepare the PostgreSQL database schemas and migrations:

```bash
npm run setup:db
```

### Starting the Application

Launch the development servers:

```bash
# Start the Node.js backend
npm run dev:backend

# Start the Python AI service
uvicorn main:app --app-dir backend/ai_service --host 0.0.0.0 --port 8001
```

By default, the backend API is available at `http://localhost:5000`, and the AI service is available at `http://localhost:8001`.

## Docker Deployment

To deploy Mimir using Docker, ensure your environment variables are set in your shell or `.env` file, and execute:

```bash
docker compose up --build
```

The Docker compose stack exposes the following services:
*   **Backend API**: `http://localhost:5000`
*   **AI Service**: `http://localhost:8001`
*   **PostgreSQL**: `localhost:5432`

## Quality Assurance

To verify the integrity of the application, run the provided test suites and build scripts:

```bash
npm run typecheck
npm test
npm run build
```

Current backend test coverage includes risk sizing, daily loss limits, duplicate position prevention, and core technical indicators. Future test expansions will focus on `signal_generator.ts` and automated scanner workflows to ensure reliability before deploying live order automation.
