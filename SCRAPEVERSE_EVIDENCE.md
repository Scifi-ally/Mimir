# Scrapeverse FII/DII Evidence Record

**Project:** Mimir, signal-only paper-trading system for Indian markets
**Collector:** Bright Data Scraper Studio as the primary collector, targeting NSE FII/DII provisional capital-market data
**Evidence date:** 17 August 2026
**Author:** Manus AI

## Scope and safety boundary

Mimir remains permanently **paper-only**. The Scrapeverse integration enriches market intelligence and auditability; it cannot submit, mirror, or authorize live broker orders. No live trading credential or order-execution path was added as part of this work.

The collector is designed around the NSE FII/DII source page, whose records are provisional and published after the trading session. The normalized schema preserves the source URL, source timestamp, collector identifiers, raw payload, record hash, and validation status so that a displayed value can be traced back to the extraction evidence.[1]

## Verified in the local repository and running stack

| Area | Verified result | Evidence |
|---|---|---|
| Normalization | FII/FPI and DII rows normalize into explicit gross purchase, gross sales, and net crore fields. | `backend/src/scrapeverse/fii_dii_collector.ts`; four collector tests pass. |
| Accounting reconciliation | Net is checked against gross purchase minus gross sales within the configured tolerance. | Collector normalization tests cover reconciliation. |
| Date handling | Numeric dates and named-month forms such as `17-Aug-2026` are parsed into the locked date field. | Collector test fixture and parser implementation. |
| Completeness | Missing category/segment fields are rejected or marked incomplete rather than silently accepted. | Collector completeness test. |
| Provenance | Raw records are retained in evidence files and normalized rows include source, collection, collector, hash, and validation metadata. | `backend/src/scrapeverse/evidence.ts` and `SCHEMA.md`. |
| Persistence | `scrapeverse_fii_dii_flows` and `scrapeverse_collector_runs` exist in PostgreSQL. | `npm run setup:db`; direct PostgreSQL schema query. |
| Migration state | Drizzle migration bookkeeping contains 13 entries through migration `0012_chubby_doctor_faustus`. | Direct query of `drizzle.__drizzle_migrations`. |
| Migration safety | The initial migration command detected an empty journal and an existing baseline. A targeted repair created only the missing Scrapeverse tables/index and explicitly refused a destructive `scan_runs` rename. | `backend/scripts/repair_scrapeverse_migration.mjs`; subsequent `npm run setup:db` completed successfully. |
| REST health | `GET /api/scrapeverse/fii-dii/health` returns HTTP 200 and reports `configured: false` with no fabricated run metrics. | Live request to `http://127.0.0.1:5000`. |
| REST latest | `GET /api/scrapeverse/fii-dii/latest` returns HTTP 200 with an empty `rows` array when no validated collection exists. | Live request to `http://127.0.0.1:5000`. |
| Scheduler | The post-market collector is wired for 17:30 IST with a 19:00 IST retry. | `backend/src/scheduler/jobs.ts`. |
| Dashboard | The frontend displays configuration state, latest validated FII/DII values, completeness, last run, and explicit unconfigured/degraded messaging. | `frontend/src/components/ScrapeverseCollectorPanel.tsx`; rendered from `Dashboard.tsx`. |
| Regression suite | Backend: 25 test files and 85 tests passed. Frontend: 3 test files and 6 tests passed. | `npm test`. |
| Build | Backend and frontend builds completed successfully. | `backend npm run build`; `frontend npm run build`. |
| Paper-only status | System status reports database and scheduler health while live broker access remains unavailable; live trading boundary tests pass. | Live `/api/system/status`; paper-only boundary tests. |

## Current live integration result

Bright Data credentials are not configured in this environment. The required variables are absent:

```text
BRIGHT_DATA_API_TOKEN
BRIGHT_DATA_FII_DII_COLLECTOR_ID
```

The live CLI was executed and produced this result:

```json
{
  "status": "not_configured",
  "collectionId": null,
  "rowsReceived": 0,
  "rowsValid": 0,
  "completenessRate": 0
}
```

The command exits with status code `2` for a non-completed collector state. This is intentional observability for automation; it is not evidence of a scraper failure. The generated evidence file is stored under `backend/evidence/scrapeverse/` and records the blocked state without inventing a collector ID or market values.

> **Important:** The repository contains no fabricated live FII/DII observations. The dashboard shows `N/A` until a real Scraper Studio collection produces validated rows.

## What remains blocked or unverified

| Requirement | State | Why it cannot be claimed yet |
|---|---|---|
| Real Bright Data Scraper Studio collection | Blocked by account configuration | A Bright Data account, published collector, and token are required. |
| End-to-end trigger/poll against Bright Data | Unverified | No real collector ID or token is available in the environment. |
| Live NSE extraction through Scraper Studio | Unverified | The source and adapter are wired, but no authenticated collection was observed. |
| Self-healing proof | Not claimed | A real layout change or a deliberately broken fixture must produce an observed adaptation event. The current code records self-healing metadata but does not pretend that an event occurred. |
| Accuracy or profitability improvement from FII/DII | Not claimed | No validated production sample exists in this environment; paper outcomes must accumulate before estimating predictive value. |

## Reproduction commands

The following commands reproduce the local verification, assuming the Mimir services are running:

```bash
cd /home/ubuntu/Mimir/backend
npm run setup:db
npm run build
npm test
npm run scrapeverse:fii-dii

curl -sS http://127.0.0.1:5000/api/scrapeverse/fii-dii/health
curl -sS http://127.0.0.1:5000/api/scrapeverse/fii-dii/latest
```

Once a real Bright Data collector is published, configure the two environment variables, restart the backend, and execute the CLI after market close. The expected successful evidence should contain a non-null collection identifier, two valid category rows, a completeness rate of `1`, and a raw response retained under `backend/evidence/scrapeverse/`.

## External references

[1]: https://www.nseindia.com/reports/fii-dii "NSE India — FII/FPI and DII trading activity"
[2]: https://docs.brightdata.com/scraping-automation/web-scraper-ide/overview "Bright Data — Web Scraper IDE / Scraper Studio overview"
[3]: https://docs.brightdata.com/scraping-automation/web-scraper-ide/api-reference "Bright Data — Scraper Studio API reference"

## Browser verification

The public Mimir frontend was opened after the final backend restart. The dashboard loaded with live index quotes, `PAPER ONLY`, `SCHEDULER ON`, `NETWORK OK`, and the Scrapeverse panel. The panel visibly showed `not configured`, `N/A` for FII/FPI net and DII net, `0%` recent completeness, and the explanatory no-fabrication message. The persisted `NOT_CONFIGURED` attempt appeared as the last run, while no validated market row was displayed.
