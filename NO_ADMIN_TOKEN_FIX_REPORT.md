# Mimir Local Access and Subsystem Verification Report

**Date:** 17 August 2026
**Scope:** Local Mimir paper-only deployment
**Status:** Verified and running

## Outcome

The local Mimir dashboard no longer requires an admin token. The development backend now uses an explicit `DISABLE_REMOTE_API_AUTH=true` setting, and the frontend no longer reads, stores, or sends `mimir_admin_token` values. The system remains permanently paper-only: no broker order endpoint can place a live order.

Remote production protection was not weakened. The no-token bypass is limited to non-production mode and is controlled by the local development environment. Production deployments still fail closed unless their configured remote authentication policy is satisfied.

## Changes Implemented

| Area | Change | Result |
|---|---|---|
| Backend HTTP authentication | Added a development-only no-token mode in `backend/src/lib/security.ts` | Browser API requests work without `x-admin-token` or `Authorization` headers |
| Backend debug routes | Applied the same local policy to development debug endpoints | Diagnostics are accessible locally without a token |
| WebSocket authentication | Removed frontend token transmission and allowed the exposed development origin | Intelligence and market-data WebSockets connect successfully |
| Frontend API client | Removed token storage detection and token header injection from `frontend/src/lib/api.ts` | No browser-side admin-token dependency remains |
| Settings UI | Replaced the token form with `ADMIN TOKEN NOT REQUIRED — PAPER-ONLY LOCAL MODE` | The product surface accurately explains local access |
| Persistent environment | Added `backend/.env` with paper-only mode, local database/Redis settings, `DISABLE_REMOTE_API_AUTH=true`, and development tunnel-origin support | The behavior persists across backend restarts |
| Startup database initialization | Initialized `scan_runs` before scheduler startup in `backend/src/index.ts` | Fresh/local databases no longer produce the startup `relation "scan_runs" does not exist` failure |
| Orchestrator initialization | Retained a defensive `scan_runs` bootstrap in `backend/src/intelligence/orchestrator.ts` | Scanner persistence remains resilient if started independently |

## Subsystem Verification

| Subsystem | Verification | Result |
|---|---|---|
| HTTP health | `GET /health` | HTTP 200; process healthy |
| Readiness | `GET /ready` | HTTP 200; database, Redis, and market feed reported ready |
| Paper-only boundary | `GET /api/trading/mode` | `PAPER`, `liveActive:false`, `paperOnly:true` |
| Disabled live orders | `GET /api/trading/live/orders` | HTTP 410 with explicit permanent paper-only response |
| Database | System status and readiness probes | Connected |
| Redis | Readiness probe | Connected |
| Scheduler | System status | Running |
| Market regime | `GET /api/market/regime` | Returned current `RANGING` regime and India VIX data |
| Macro and India context | `GET /api/market/macro`, `GET /api/market/indian-context` | Returned structured context with honest unavailable fields where no source was configured |
| Paper account | `GET /api/paper/account`, positions, history | Account returned; positions/history available and empty rather than failing |
| Suggestions | Active and historical suggestion endpoints | Returned valid empty collections |
| Expectancy reporting | `GET /api/reports/expectancy?days=7` | Returned valid zero-sample metrics with null insufficient-sample values |
| Screener | Screener list endpoint | Returned valid empty collection |
| Intelligence WebSocket | No-token connection to `/ws/intelligence` | Opened successfully and received messages |
| Market-data WebSocket | No-token connection to `/ws/market-data` | Opened successfully and received messages |
| Browser realtime state | Exposed dashboard refresh after origin fix | `NETWORK OK`; backend status reported `wsConnected:true` |

## Browser Verification

The exposed dashboard is available at:

<https://3000-ir36bvkpxl4sjnpcxvb70-71fd6690.us4.manus.computer/>

The refreshed dashboard loaded without an admin-token prompt. Its settings dialog showed the explicit local-access message, and the main status surface showed `PAPER ONLY`, `SCHEDULER ON`, and `NETWORK OK` after the origin-policy fix.

## Regression Validation

The final validation was run after the authentication, origin, and startup-order changes.

| Check | Result |
|---|---:|
| Backend TypeScript check | Passed |
| Backend build | Passed |
| Backend lint | Passed |
| Backend tests | 24 files, 80 tests passed |
| Frontend TypeScript check | Passed |
| Frontend production build | Passed |
| Frontend lint | Passed |
| Frontend tests | 3 files, 6 tests passed |
| `git diff --check` | Passed |

## Remaining Expected Limitations

Upstox is currently unauthenticated in this local instance because no read-only Upstox data token has been configured. The application therefore uses its documented fallback/degraded behavior for optional live-feed features; this is distinct from the removed Mimir admin-token requirement. The AI service is also in its native Node.js fallback mode because the optional FastAPI service is not running. Neither condition prevents the paper account, signal data contracts, India-context fallback handling, scheduler, HTTP API, or browser realtime channels from operating.

This system is for research and paper-trading analysis only. It does not execute live orders, and its signals are not guaranteed investment advice.
