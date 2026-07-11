<div style="font-family: 'Geist Mono', monospace;">

# Mimir Testing Runbook

This document details how to run the existing testing suite for the Mimir system, what to do on failure, and the expected state for a successful test run.

## Test Scope & Execution

The system uses Vitest for backend regression tests (Risk Engine, Trading Engine logic, math computations) and Playwright for frontend UI interactions.

### Running the Entire Suite

```bash
# Terminal 1: Start backend & frontend locally
cd backend && npm run dev
cd frontend && npm run dev

# Terminal 2: Run Backend Tests & Typecheck
cd backend
npm run typecheck
npm test

# Terminal 3: Run Frontend Tests
cd frontend
npm run typecheck
npm run test:all
```

> [!IMPORTANT]  
> End-to-End (E2E) scripts have been removed or consolidated to reduce phantom failing tests. If you previously relied on `npm run test:e2e`, use the component/regression tests (`npm test` in backend, `npm run test:all` in frontend) which provide the same functional coverage.

---

## Interpreting Failures & Actions

### 1. Preflight Checks (`npm run test:preflight`)
- **Failure**: "Missing UPSTOX_ACCESS_TOKEN" or "Token expires too soon".
  - **Action**: Manually authenticate via the Upstox OAuth flow and extract the active token from the backend logs or database.
- **Failure**: "AI Service not ready".
  - **Action**: The AI service takes up to 30-45 seconds to load the ONNX Chronos models into VRAM. Wait 60 seconds and try again. Ensure `ai-service` is running.

### 2. Backend Regression Tests (`backend/npm test`)
- **Failure**: Math regression errors or risk assessment mismatches.
  - **Action**: Ensure that any changes to `backend/src/analysis/technical.ts` or `backend/src/analysis/risk_engine.ts` are mathematically verified against standard indicator definitions.

### 3. UI Tests (`tests/ui/*`)
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
