-- Discriminate which pipeline wrote each overnight_watchlist row.
--
-- Four scanners share this table: overnight, post-market, gap and intraday.
-- Each used to DELETE every row for the date before inserting its own, so
-- running the post-market scanner manually after the off-hours scan replaced the
-- richer off-hours output with a weaker set - the post-market scanner scores
-- from analyzeMultiTimeframe, which applies none of the 15 setup detectors,
-- liquidity gates, RS hard gates or the score floor that scanStock does.
--
-- The data was silently lost, and nothing in the logs indicated it.
ALTER TABLE "overnight_watchlist" ADD COLUMN IF NOT EXISTS "source" varchar(30);

-- Existing rows predate the column. They were overwhelmingly written by the
-- off-hours scanner (15:45) and the gap scanner; post-market runs at 15:31 and
-- was usually overwritten by the later off-hours pass anyway. Defaulting is safe
-- because nothing deletes on source until the writers are updated in step with
-- this migration.
UPDATE "overnight_watchlist"
SET "source" = 'OFFHOURS_SCAN'
WHERE "source" IS NULL;

ALTER TABLE "overnight_watchlist" ALTER COLUMN "source" SET DEFAULT 'OFFHOURS_SCAN';
ALTER TABLE "overnight_watchlist" ALTER COLUMN "source" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "watchlist_date_source_idx" ON "overnight_watchlist" USING btree ("for_date","source");