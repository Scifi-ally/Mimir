# Scrapeverse FII/DII Collector Schema

## Scope decision

The primary Scrapeverse collector is **NSE/BSE combined FII/FPI and DII trading activity in the capital-market segment**. The collector targets the official NSE FII/DII activity page:

`https://www.nseindia.com/reports/fii-dii`

The page states that the combined FII/FPI and DII activity is collated across BSE, NSE, and MSEI. FII/FPI data is based on the day’s activity compiled from PAN information provided by NSDL and is provisional; DII data is based on trading-member classifications. The collector therefore records the published market date separately from the time at which Scraper Studio retrieved the page.

The first implementation does **not** combine FII/DII, corporate announcements, and GIFT Nifty into one collector. Keeping one collector focused makes field completeness, source failures, and self-healing evidence auditable.

## Refresh policy

The source is generally updated after the trading session when provisional capital-market activity is published. The collector should run once after the expected publication window, with an optional second retry later in the evening if the first run returns no valid rows. It must not be polled at high frequency during the live session because same-day FII/DII figures are not a reliable intraday feed.

Recommended default schedule: **17:30 IST on trading days**, with a bounded retry at **19:00 IST** only when the first run is unsuccessful or incomplete. The stored row must retain `scraped_at` and `data_as_of`; the latter is the date represented by the source table, not the retrieval date.

## Broken-page definition

The collector is considered broken or degraded when any of the following occurs:

1. Scraper Studio returns no rows or an empty table.
2. The source page renders a challenge, error page, login page, or unrelated content.
3. The expected FII/FPI or DII category cannot be identified from the returned structured output.
4. A required numeric value is missing, non-numeric, or outside conservative sanity bounds.
5. The source date is missing, invalid, in the future beyond a small clock-skew allowance, or older than the configured freshness window.
6. Gross purchase, gross sales, and net values violate the accounting relationship within the allowed rounding tolerance.
7. Scraper Studio returns a structurally different field set that cannot be mapped to the locked schema.

A broken run is recorded as a failed or incomplete collector run. It is never silently converted into zero flows and never overwrites the last known valid row.

## Locked structured output

The collector output is one normalized observation per category and source date. The canonical schema is:

| Field | Type | Required | Meaning and validation |
|---|---|---:|---|
| `source` | `enum` | Yes | Always `NSE_FII_DII_CAPITAL_MARKET` for this collector. |
| `source_url` | `string` | Yes | The official NSE FII/DII activity page URL. |
| `data_as_of` | `date` (`YYYY-MM-DD`) | Yes | The trading date represented by the source row. |
| `category` | `enum` | Yes | Either `FII_FPI` or `DII`; source labels such as `FII/FPI` are normalized into this enum. |
| `segment` | `enum` | Yes | `CAPITAL_MARKET`; this collector does not mix cash-market rows with derivatives rows. |
| `gross_purchase_crore` | `number` | Yes | Gross purchase value in INR crore. Must be finite and non-negative. |
| `gross_sales_crore` | `number` | Yes | Gross sales value in INR crore. Must be finite and non-negative. |
| `net_crore` | `number` | Yes | Net purchase/sale in INR crore, where positive means net buying and negative means net selling. |
| `scraped_at` | `timestamp` | Yes | UTC timestamp when Bright Data returned the structured record. |
| `collector_id` | `string` | Yes | Published Bright Data Scraper Studio collector ID, normally beginning with `c_`. |
| `collection_id` | `string` | Yes | Bright Data asynchronous collection/snapshot ID for this run. |
| `raw_record_hash` | `string` | Yes | SHA-256 hash of the canonical raw record for deduplication and audit. |
| `validation_status` | `enum` | Yes | `VALID`, `INCOMPLETE`, or `INVALID`. Only `VALID` rows may update the latest usable institutional-flow state. |
| `raw_payload` | `object` | Yes | The exact structured record returned by Scraper Studio, retained for audit and reprocessing. |

## Collector-run health schema

Every trigger and result retrieval is also recorded as a run-health observation:

| Field | Type | Meaning |
|---|---|---|
| `collector_id` | `string` | Published Scraper Studio collector handle. |
| `collection_id` | `string` | Bright Data job/snapshot identifier. |
| `started_at` | `timestamp` | Trigger time. |
| `completed_at` | `timestamp` | Result-ready or terminal-failure time. |
| `status` | `enum` | `TRIGGERED`, `BUILDING`, `SUCCEEDED`, `INCOMPLETE`, `FAILED`, `SELF_HEAL_PENDING`, or `SELF_HEALED`. |
| `rows_received` | `integer` | Number of raw rows returned. |
| `rows_valid` | `integer` | Number of rows satisfying the locked schema. |
| `completeness_rate` | `number` | Valid required fields divided by expected required fields. |
| `last_error` | `string` | Sanitized error category; secrets and raw authorization headers are never stored. |
| `self_heal_event_id` | `string?` | Set only when a real Scraper Studio self-heal event has been observed and recorded. |
| `raw_response_path` | `string?` | Local evidence path when raw output is persisted outside the database. |

## Semantics and constraints

FII/DII values are **provisional source data**, not an intraday trading signal. A valid row is suitable for dated market context and post-market analysis. It must not be treated as same-day live confirmation before the source has published that date’s activity.

The collector must preserve the raw Scraper Studio record and its source date. It must not fabricate zeros, copy the scrape date into `data_as_of`, or overwrite yesterday’s data with a failed or incomplete run.
