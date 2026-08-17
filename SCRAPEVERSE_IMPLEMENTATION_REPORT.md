# Scrapeverse FII/DII Implementation Report

**Repository:** `Scifi-ally/Mimir`
**Product boundary:** India-focused, signal-only paper trading; live order execution is permanently disabled
**Implementation date:** 17 August 2026
**Author:** Manus AI

## Executive result

The Scrapeverse hackathon integration is implemented as a production-shaped, provenance-preserving FII/DII collector pipeline. Bright Data Scraper Studio is the designated primary collector, while NSE remains the source page. The system normalizes, reconciles, validates, persists, exposes, schedules, and displays FII/DII data without fabricating values when Bright Data is unavailable.

The implementation is **locally verified and running**, but live Scraper Studio collection is **not yet observed** because this environment has no Bright Data token or published collector ID. That limitation is explicit in the API, CLI, dashboard, and evidence files.

## Delivered architecture

| Layer | Implementation | Purpose |
|---|---|---|
| Source contract | `SCHEMA.md` | Locks field names, units, provenance, validation, and rejection behavior. |
| Bright Data adapter | `backend/src/scrapeverse/bright_data_client.ts` | Triggers a published collector, polls its dataset, handles timeout/failure, and returns `not_configured` without credentials. |
| Normalizer | `backend/src/scrapeverse/fii_dii_collector.ts` | Parses dates and numeric values, maps FII/FPI and DII categories, reconciles net values, and enforces completeness. |
| Evidence writer | `backend/src/scrapeverse/evidence.ts` | Retains raw collection responses, normalized rows, and blocked/error outcomes under `backend/evidence/scrapeverse/`. |
| Persistence service | `backend/src/scrapeverse/fii_dii_service.ts` | Stores collector runs and validated flows, and updates the legacy institutional-flow compatibility path. |
| Database | `scrapeverse_collector_runs`, `scrapeverse_fii_dii_flows` | Supports run health, audit traceability, normalized values, raw payloads, hashes, and validation status. |
| REST API | `/api/scrapeverse/fii-dii/health`, `/api/scrapeverse/fii-dii/latest` | Serves collector status and latest validated values to the UI and operators. |
| Scheduler | 17:30 IST plus 19:00 IST retry | Runs after the NSE provisional post-market publication window and avoids intraday use of late data. |
| Dashboard | `ScrapeverseCollectorPanel.tsx` | Shows configuration, FII/FPI net, DII net, data date, scrape time, completeness, last run, and explicit unavailable states. |
| CLI | `npm run scrapeverse:fii-dii` | Provides an auditable manual/scheduled execution path. Exit code `2` identifies a non-completed collector state. |

The browser verification confirmed that the running Mimir page renders the panel with `not configured`, `N/A` FII/FPI and DII values, `0%` recent completeness, and an explanatory message. The footer simultaneously reports **PAPER ONLY**, **SCHEDULER ON**, **NETWORK OK**, and degraded AI mode, which is consistent with the configured local environment.

## Database activation and repair

The first standard migration attempt correctly stopped rather than overwriting existing relations: the local database already contained the baseline Mimir tables but had an empty Drizzle migration journal. A destructive schema-push attempt was also aborted because it proposed deleting the existing `scan_runs` table.

A targeted repair script, `backend/scripts/repair_scrapeverse_migration.mjs`, was then added. It creates only the two missing Scrapeverse tables and the collection index, applies the already-present compatibility alterations idempotently, and reconstructs Drizzle bookkeeping from the repository journal. After the repair:

```text
npm run setup:db
Database migrations completed successfully.

PostgreSQL verification:
- scrapeverse_collector_runs exists
- scrapeverse_fii_dii_flows exists
- scrapeverse_collector_runs_collection_id exists
- drizzle migration count: 13
```

No `scan_runs` table or row was deleted.

## API verification

With the rebuilt backend running on port `5000`, the following responses were observed:

```json
GET /api/scrapeverse/fii-dii/health
{
  "configured": false,
  "collectorId": null,
  "sourceUrl": "https://www.nseindia.com/reports/fii-dii",
  "lastRun": null,
  "recentRunCount": 0,
  "recentSuccessCount": 0,
  "recentCompletenessRate": null
}
```

```json
GET /api/scrapeverse/fii-dii/latest
{
  "source": "NSE_FII_DII_CAPITAL_MARKET",
  "rows": []
}
```

The empty result is the correct response before a validated Bright Data collection exists. It is not a placeholder market reading.

## Validation matrix

| Check | Result |
|---|---:|
| Backend typecheck | Passed |
| Backend lint | Passed |
| Backend build | Passed |
| Frontend build | Passed |
| Backend regression suite | 25 files, 85 tests passed |
| Frontend regression suite | 3 files, 6 tests passed |
| `git diff --check` | Passed |
| PostgreSQL migration activation | Passed after targeted non-destructive repair |
| Scrapeverse normalization tests | 4 passed |
| Live health endpoint | HTTP 200 |
| Live latest endpoint | HTTP 200 |
| Browser dashboard load | Passed |
| Bright Data live collection | Blocked by missing account configuration |
| Self-healing event proof | Not claimed |

## Configuration required for live collection

After publishing the collector in a real Bright Data account, configure the backend environment with:

```text
BRIGHT_DATA_API_TOKEN=<real Bright Data API token>
BRIGHT_DATA_FII_DII_COLLECTOR_ID=<published Scraper Studio collector ID>
```

Restart the backend, run the CLI after the NSE publication window, and inspect the generated evidence file. A successful run must produce a non-null collection ID, two valid category rows, a complete accounting reconciliation, and raw evidence linked to the normalized rows.

The collector trigger/poll flow follows Bright Data’s documented Scraper Studio API behavior.[2] The source URL is the NSE FII/DII report page.[1]

## Claims deliberately not made

This implementation does not claim that a live collector has run, that self-healing has been demonstrated, or that FII/DII flow data has improved signal profitability. Those claims require authenticated collections and a statistically meaningful paper-trading sample. The system is prepared to measure those outcomes, but it does not substitute assumptions for evidence.

## References

[1]: https://www.nseindia.com/reports/fii-dii "NSE India — FII/FPI and DII trading activity"
[2]: https://docs.brightdata.com/scraping-automation/web-scraper-ide/api-reference "Bright Data — Scraper Studio API reference"
