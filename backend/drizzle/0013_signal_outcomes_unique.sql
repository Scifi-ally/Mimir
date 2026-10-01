-- One realised outcome per suggestion.
--
-- signal_outcomes had a full schema and no rows because nothing wrote to it.
-- The accuracy tracker now records an outcome whenever it closes a suggestion,
-- but without a unique key two concurrent verifiers (or an expiry pass racing a
-- verifier) could both insert for the same suggestion, which would double-count
-- it in every downstream average.
--
-- Existing rows are collapsed first so the constraint applies cleanly on any
-- database that somehow already has duplicates.
DELETE FROM "signal_outcomes" a
USING "signal_outcomes" b
WHERE a."suggestion_id" IS NOT NULL
  AND a."suggestion_id" = b."suggestion_id"
  AND a."id" > b."id";
--> statement-breakpoint
DELETE FROM "signal_outcomes" WHERE "suggestion_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "signal_outcomes_suggestion_unq" ON "signal_outcomes" USING btree ("suggestion_id");