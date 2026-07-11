<div style="font-family: 'Geist Mono', monospace;">

# Mimir Testing Runbook

This document details how to run the massive end-to-end audit testing suite for the Mimir system, what to do on failure, and the expected state for a successful test run.

## Test Scope & Execution

The system uses Vitest for the backend tests (Infrastructure, REST, WebSockets, Logic, Performance) and Playwright for the frontend tests (UI interactions, Dynamic Island, Charting, Smoke).

### Running the Entire Suite

```bash
# Terminal 1: Start backend & frontend locally
cd backend && npm run dev
cd frontend && npm run dev

# Terminal 2: Run Backend Tests
cd backend && npm run test:all

# Terminal 3: Run Frontend Tests
cd frontend && npm run test:all
```

> [!IMPORTANT]  
> The backend tests require the PostgreSQL and Redis containers to be actively running. Ensure you have run `docker-compose up -d postgres redis` before beginning.

---

## Interpreting Failures & Actions

### 1. Preflight Checks (`npm run test:preflight`)
- **Failure**: "Missing UPSTOX_ACCESS_TOKEN" or "Token expires too soon".
  - **Action**: Manually authenticate via the Upstox OAuth flow and extract the active token from the backend logs or database.
- **Failure**: "AI Service not ready".
  - **Action**: The AI service takes up to 30-45 seconds to load the ONNX Chronos models into VRAM. Wait 60 seconds and try again. Ensure `ai-service` is running.

### 2. Database Integrity (`tests/db/integrity.test.ts`)
- **Failure**: Missing columns or tables.
  - **Action**: Run `npm run db:push` in the backend directory to apply Drizzle schema updates.
- **Failure**: Constraint violations.
  - **Action**: A migration might be out of sync, or the DB has dirty test data. Manually clear the tables or run `npm run setup:db`.

### 3. Redis Cache Integrity (`tests/cache/redis.test.ts`)
- **Failure**: Namespace collision.
  - **Action**: The backend is improperly using `bull:` prefix instead of `mimir:` prefix for app-level caching. Check the Redis wrapper logic.

### 4. WebSocket Routing (`tests/ws/channels.test.ts`)
- **Failure**: Timeout waiting for `system_health`.
  - **Action**: Ensure `process.env.UPSTOXBOT_ADMIN_TOKEN` matches the debug header. The debug route `POST /api/system/debug/set-regime` triggers this.

### 5. UI Tests & Smoke Test (`tests/ui/*` & `tests/e2e/smoke.test.ts`)
- **Failure**: Chart Canvas timeout.
  - **Action**: If running headless in CI, ensure XVFB or appropriate browser environments are installed. Playwright handles this generally, but ensure the Vite frontend compiles successfully.
- **Failure**: "Active [0]" in watchlist.
  - **Action**: Triggering `trigger-scan` must generate at least 1 mock suggestion, otherwise UI tests relying on active trades will stall.

---

## Mocking & Mimir Architecture

**Mimir strictly avoids mocking when possible.**
The debug endpoints (`/api/system/debug/*`) are the designated way to force the system into specific states (like circuit breakers, or RANGING regimes) without stubbing the core business logic. 

> [!CAUTION]  
> Never deploy the system with `NODE_ENV=development` as it exposes the debug endpoints. The Admin Token serves as a secondary guard, but strict environment boundaries must be maintained.


</div>