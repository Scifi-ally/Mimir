# Mimir

AI-assisted Indian stock market dashboard with an Express/TypeScript backend, React/Vite frontend, FastAPI AI service, and PostgreSQL storage.

## Safety Defaults

- Remote backend API access is disabled unless `UPSTOXBOT_ADMIN_TOKEN` is set.
- The example env leaves admin tokens blank instead of shipping an insecure placeholder.
- Non-local `/api` calls are rate-limited by default to 120 requests per minute.
- AI service CORS is restricted to configured/local origins via `AI_CORS_ORIGINS`.
- Trading config loaded from the database is no longer silently loosened at startup.

## Local Setup

1. Install Node.js 22+, Python 3.12+, and PostgreSQL 16+.
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, Upstox credentials, `UPSTOXBOT_SECRET_KEY`, and a strong `UPSTOXBOT_ADMIN_TOKEN` if using remote clients.
3. Install dependencies:

```bash
npm install
npm --prefix backend install --legacy-peer-deps
pip install -r backend/ai_service/requirements.txt
```

4. Prepare the database:

```bash
npm run setup:db
```

5. Start services:

```bash
npm run dev:backend
uvicorn main:app --app-dir backend/ai_service --host 0.0.0.0 --port 8001
```

Backend defaults to `http://localhost:5000`, and the AI service defaults to `http://localhost:8001`.

## Docker

Set secrets in your shell or an `.env` file, then run:

```bash
docker compose up --build
```

The compose stack exposes:

- Backend API: `http://localhost:5000`
- AI service: `http://localhost:8001`
- PostgreSQL: `localhost:5432`

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Current backend test coverage starts with risk sizing, daily loss limits, duplicate positions, and core technical indicators. Add tests next around `signal_generator.ts` and scanner workflows before trusting live order automation.
