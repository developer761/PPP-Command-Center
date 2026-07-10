-- 045_commercial_ceo_status_model.sql
--
-- CEO status-model amendment (Plan v1.1, 2026-07-09 PM).
-- The Phase A commit shipped a 9-status list. Alex's email replaces it
-- with an 8-value Pre-Contract list; this migration remaps historic
-- rows without data loss + widens the existing loss_reason CHECK
-- constraints so `no_bid` becomes a first-class loss reason (was a
-- first-class status in v1.0). Also adds `previous_status` so the
-- `reopened → solicitation` mapping doesn't destroy audit-trail context.
--
-- IMPORTANT — the previous draft of this migration created a NEW
-- column called `lost_reason` (with a T). That was a typo — the real
-- column is `loss_reason` (LOSS with an S), defined in migration 028
-- and already used by the lib layer. This corrected version widens
-- the EXISTING `loss_reason` CHECK constraint instead of creating a
-- new column. Safe to re-run over any state.
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
--   no_bid               → lost          (loss_reason = 'no_bid' preserved)
--   site_visit_scheduled → estimating    (already done by migration 044,
--                                         included here for safety re-run)
--   site_visit_done      → estimating    (same)
--
-- Rerun-safe: every ALTER is idempotent (drop-then-recreate on the
-- CHECK constraint); every UPDATE is a WHERE-scoped no-op after first
-- application.

BEGIN;

-- 1. Widen the loss_reason CHECK on commercial_opportunities to include
--    'no_bid' as a first-class reason. Postgres doesn't allow altering
--    a CHECK in place — drop by known constraint name if present, then
--    re-add. The original constraint was auto-named by migration 028
--    as `commercial_opportunities_loss_reason_check` (Postgres default
--    naming for CHECK on a single column).
DO $$
DECLARE
  constraint_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'commercial_opportunities_loss_reason_check'
       AND conrelid = 'public.commercial_opportunities'::regclass
  ) INTO constraint_exists;

  IF constraint_exists THEN
    ALTER TABLE public.commercial_opportunities
      DROP CONSTRAINT commercial_opportunities_loss_reason_check;
  END IF;
END $$;

ALTER TABLE public.commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_loss_reason_check
  CHECK (loss_reason IS NULL OR loss_reason IN (
    'no_bid',
    'price',
    'scope',
    'timing',
    'no_decision',
    'awarded_to_competitor',
    'relationship',
    'other'
  ));

-- 2. Same widening on the status log table so historic transitions
--    can carry `no_bid` as a reason on future lost inserts.
DO $$
DECLARE
  constraint_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'commercial_opportunity_status_log_loss_reason_check'
       AND conrelid = 'public.commercial_opportunity_status_log'::regclass
  ) INTO constraint_exists;

  IF constraint_exists THEN
    ALTER TABLE public.commercial_opportunity_status_log
      DROP CONSTRAINT commercial_opportunity_status_log_loss_reason_check;
  END IF;
END $$;

ALTER TABLE public.commercial_opportunity_status_log
  ADD CONSTRAINT commercial_opportunity_status_log_loss_reason_check
  CHECK (loss_reason IS NULL OR loss_reason IN (
    'no_bid',
    'price',
    'scope',
    'timing',
    'no_decision',
    'awarded_to_competitor',
    'relationship',
    'other'
  ));

-- 3. Add previous_status snapshot so the "reopened → solicitation"
--    mapping doesn't destroy audit-trail context. Populated on any
--    status change trigger going forward; backfilled below for existing
--    reopened rows.
ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS previous_status TEXT;

COMMENT ON COLUMN public.commercial_opportunities.previous_status IS
  'Snapshot of the prior status. Preserves reopened-from-what context
   after the CEO status model dropped reopened as a first-class value
   (Plan v1.1, 2026-07-09).';

-- 4. Clean up the mistaken `lost_reason` column if the previous draft
--    of this migration ran and created it. Safe no-op if the column
--    doesn't exist.
ALTER TABLE public.commercial_opportunities
  DROP COLUMN IF EXISTS lost_reason;

-- 5. Backfill loss_reason for existing no_bid status rows BEFORE we
--    collapse the status. Order matters: read no_bid, write loss_reason,
--    then change status. This preserves the "we passed" distinction
--    that would otherwise be lost when no_bid rolls into lost.
UPDATE public.commercial_opportunities
   SET loss_reason = 'no_bid',
       updated_at = now()
 WHERE status = 'no_bid'
   AND (loss_reason IS NULL OR loss_reason <> 'no_bid');

-- 6. Backfill previous_status for existing reopened rows. We don't
--    know the exact prior status without reading the audit log; snapshot
--    a sentinel value so future code knows "this was reopened, but we
--    don't have the prior state" instead of NULL (which reads as
--    "never reopened").
UPDATE public.commercial_opportunities
   SET previous_status = 'reopened_unknown_prior',
       updated_at = now()
 WHERE status = 'reopened'
   AND previous_status IS NULL;

-- 7. Migrate historic status values to the CEO status model.
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

-- 8. Sanity check — after migration, every row should be in one of
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
