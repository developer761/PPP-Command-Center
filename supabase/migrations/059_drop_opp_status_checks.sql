-- Migration 059: drop the commercial_opportunities status + sub_status
-- CHECK constraints entirely per Karan 2026-07-15.
--
-- Rationale: Karan kept hitting "violates check constraint
-- commercial_opportunities_status_check" when trying to move deals
-- freely on the Kanban. He explicitly asked for "no constraints
-- whatsoever" — he wants the drag-and-drop to just work regardless
-- of the (status, sub_status) tuple.
--
-- App-layer safety: changeOpportunityStatus() +
-- createCommercialOpportunity() + updateCommercialOpportunity() all
-- already default sub_status via DEFAULT_SUB_STATUS_BY_STATUS, and
-- the TypeScript enums keep bad values from being written from the
-- UI. Dropping the DB CHECK just removes the last hard-blocker that
-- kept edge-case drags from succeeding.
--
-- Idempotent: uses IF EXISTS so re-running is a no-op.

BEGIN;

ALTER TABLE public.commercial_opportunities
  DROP CONSTRAINT IF EXISTS commercial_opportunities_status_check;

ALTER TABLE public.commercial_opportunities
  DROP CONSTRAINT IF EXISTS commercial_opportunities_sub_status_check;

-- Also drop any legacy status_valid CHECK from v1 that might still be
-- lingering on the row (defensive — migration 052/058 should have
-- already handled these, but no harm in a belt-and-suspenders drop).
ALTER TABLE public.commercial_opportunities
  DROP CONSTRAINT IF EXISTS commercial_opportunities_status_valid;

DO $$
BEGIN
  RAISE NOTICE 'Migration 059: dropped opportunity status + sub_status CHECK constraints. Kanban drags now flow freely.';
END $$;

COMMIT;
