-- 045_commercial_ceo_status_model.sql
--
-- CEO status-model amendment (Plan v1.1, 2026-07-09 PM).
-- The Phase A commit shipped a 9-status list. Alex's email replaces it
-- with an 8-value Pre-Contract list; this migration remaps historic
-- rows without data loss + adds the two columns that preserve
-- distinctions the new enum drops (`lost_reason`, `previous_status`).
--
-- Old → New mapping (see Plan v1.1 AMENDMENT block for reasoning):
--   inquiry              → solicitation
--   reopened             → solicitation  (previous_status snapshot preserved)
--   estimating           → estimating    (unchanged)
--   proposal_sent        → proposal_sent (unchanged)
--   negotiating          → follow_up
--   on_hold              → follow_up     (Pre-Contract has no on_hold;
--                                         Post-Contract WIP does)
--   won                  → won           (unchanged)
--   lost                 → lost          (unchanged)
--   no_bid               → lost          (lost_reason = 'no_bid' preserved)
--   site_visit_scheduled → estimating    (already done by migration 044,
--                                         included here for safety re-run)
--   site_visit_done      → estimating    (same)
--
-- Rerun-safe: every ADD COLUMN is IF NOT EXISTS; every UPDATE is a
-- WHERE-scoped no-op after first application.

BEGIN;

-- 1. Add lost_reason column so we can preserve the no_bid distinction
--    without a separate status. Also useful for Win/Loss reporting
--    even for non-no_bid losses.
ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS lost_reason TEXT
    CHECK (lost_reason IS NULL OR lost_reason IN (
      'no_bid', 'chose_competitor', 'budget', 'timeline', 'scope_creep', 'other'
    ));

COMMENT ON COLUMN public.commercial_opportunities.lost_reason IS
  'Reason for a lost bid. Preserves the old no_bid distinction after the
   CEO status model collapsed no_bid into lost (Plan v1.1, 2026-07-09).';

-- 2. Add previous_status snapshot so the "reopened → solicitation"
--    mapping doesn't destroy audit-trail context. Populated on any
--    status change trigger going forward; backfilled below for existing
--    reopened rows.
ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS previous_status TEXT;

COMMENT ON COLUMN public.commercial_opportunities.previous_status IS
  'Snapshot of the prior status. Preserves reopened-from-what context
   after the CEO status model dropped reopened as a first-class value
   (Plan v1.1, 2026-07-09).';

-- 3. Backfill lost_reason for existing no_bid rows BEFORE we collapse
--    the status. Order matters: read no_bid, write lost_reason, then
--    change status.
UPDATE public.commercial_opportunities
   SET lost_reason = 'no_bid',
       updated_at = now()
 WHERE status = 'no_bid'
   AND lost_reason IS NULL;

-- 4. Backfill previous_status for existing reopened rows. We don't
--    know the exact prior status without reading the audit log; snapshot
--    a sentinel value so future code knows "this was reopened, but we
--    don't have the prior state" instead of NULL (which reads as
--    "never reopened").
UPDATE public.commercial_opportunities
   SET previous_status = 'reopened_unknown_prior',
       updated_at = now()
 WHERE status = 'reopened'
   AND previous_status IS NULL;

-- 5. Migrate historic rows to the CEO status model.
--    Order chosen so any row moves exactly once.
UPDATE public.commercial_opportunities
   SET status = 'solicitation',
       updated_at = now()
 WHERE status IN ('inquiry', 'reopened');

UPDATE public.commercial_opportunities
   SET status = 'follow_up',
       updated_at = now()
 WHERE status IN ('negotiating', 'on_hold');

UPDATE public.commercial_opportunities
   SET status = 'lost',
       updated_at = now()
 WHERE status = 'no_bid';

-- Defense in depth: site_visit_* rows should already be migrated
-- to estimating by migration 044, but re-apply here so this migration
-- is safe to run standalone if 044 was skipped.
UPDATE public.commercial_opportunities
   SET status = 'estimating',
       updated_at = now()
 WHERE status IN ('site_visit_scheduled', 'site_visit_done');

-- 6. Sanity check — after migration, every row should be in one of
--    the 8 new Pre-Contract values. This is a diagnostic-only
--    RAISE NOTICE (no failure) so an unexpected stray value logs but
--    doesn't block the transaction.
DO $$
DECLARE
  bad_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_count
    FROM public.commercial_opportunities
   WHERE status NOT IN (
     'solicitation', 'rfp', 'estimating', 'proposal_pending_approval',
     'proposal_sent', 'follow_up', 'won', 'lost'
   );
  IF bad_count > 0 THEN
    RAISE NOTICE 'Migration 045: % opportunity rows still have a status value outside the new Pre-Contract enum. Check manually before flipping the code.', bad_count;
  END IF;
END $$;

COMMIT;
