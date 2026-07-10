-- 045_commercial_ceo_status_model.sql
--
-- CEO status-model amendment (Plan v1.1, 2026-07-09 PM).
--
-- Karan 2026-07-10: v3 rewrite. The v2 migration hit a
-- commercial_opportunities_status_check violation because the CHECK
-- constraint on the status column only whitelists v1.0 values —
-- UPDATE-ing a row to 'solicitation' triggers CHECK before any other
-- step runs. This version widens the constraint to accept BOTH old +
-- new values FIRST, runs the data migration, then narrows to just the
-- new 8 values.
--
-- Same treatment on commercial_opportunity_status_log.from_status +
-- .to_status — those are an append-only audit trail, so we
-- PERMANENTLY widen them (never narrow) so historic rows survive AND
-- future writes with new values succeed.
--
-- Idempotent throughout. Safe to re-run over any state.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════
-- 1. Widen loss_reason CHECK on both tables to include 'no_bid'.
-- ═══════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'commercial_opportunities_loss_reason_check'
       AND conrelid = 'public.commercial_opportunities'::regclass
  ) THEN
    ALTER TABLE public.commercial_opportunities
      DROP CONSTRAINT commercial_opportunities_loss_reason_check;
  END IF;
END $$;

ALTER TABLE public.commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_loss_reason_check
  CHECK (loss_reason IS NULL OR loss_reason IN (
    'no_bid','price','scope','timing','no_decision',
    'awarded_to_competitor','relationship','other'
  ));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'commercial_opportunity_status_log_loss_reason_check'
       AND conrelid = 'public.commercial_opportunity_status_log'::regclass
  ) THEN
    ALTER TABLE public.commercial_opportunity_status_log
      DROP CONSTRAINT commercial_opportunity_status_log_loss_reason_check;
  END IF;
END $$;

ALTER TABLE public.commercial_opportunity_status_log
  ADD CONSTRAINT commercial_opportunity_status_log_loss_reason_check
  CHECK (loss_reason IS NULL OR loss_reason IN (
    'no_bid','price','scope','timing','no_decision',
    'awarded_to_competitor','relationship','other'
  ));

-- ═══════════════════════════════════════════════════════════════════
-- 2. WIDEN status_log from_status + to_status CHECKs to accept both
--    v1.0 and v1.1 values PERMANENTLY. This is an append-only audit
--    trail — historic rows must keep their v1.0 values; future writes
--    use v1.1 values. Both sets are permanent.
-- ═══════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'commercial_opportunity_status_log_from_status_check'
       AND conrelid = 'public.commercial_opportunity_status_log'::regclass
  ) THEN
    ALTER TABLE public.commercial_opportunity_status_log
      DROP CONSTRAINT commercial_opportunity_status_log_from_status_check;
  END IF;
END $$;

ALTER TABLE public.commercial_opportunity_status_log
  ADD CONSTRAINT commercial_opportunity_status_log_from_status_check
  CHECK (from_status IS NULL OR from_status IN (
    -- v1.1 (current)
    'solicitation','rfp','estimating','proposal_pending_approval',
    'proposal_sent','follow_up','won','lost',
    -- v1.0 (historic — kept for audit trail)
    'inquiry','site_visit_scheduled','site_visit_done',
    'negotiating','on_hold','no_bid','reopened'
  ));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'commercial_opportunity_status_log_to_status_check'
       AND conrelid = 'public.commercial_opportunity_status_log'::regclass
  ) THEN
    ALTER TABLE public.commercial_opportunity_status_log
      DROP CONSTRAINT commercial_opportunity_status_log_to_status_check;
  END IF;
END $$;

ALTER TABLE public.commercial_opportunity_status_log
  ADD CONSTRAINT commercial_opportunity_status_log_to_status_check
  CHECK (to_status IN (
    'solicitation','rfp','estimating','proposal_pending_approval',
    'proposal_sent','follow_up','won','lost',
    'inquiry','site_visit_scheduled','site_visit_done',
    'negotiating','on_hold','no_bid','reopened'
  ));

-- ═══════════════════════════════════════════════════════════════════
-- 3. TEMPORARILY widen commercial_opportunities.status CHECK to accept
--    both v1.0 and v1.1 values so the UPDATE statements below don't
--    trip the constraint. Also drop the DEFAULT so we can change it
--    to 'solicitation' after the migration.
-- ═══════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'commercial_opportunities_status_check'
       AND conrelid = 'public.commercial_opportunities'::regclass
  ) THEN
    ALTER TABLE public.commercial_opportunities
      DROP CONSTRAINT commercial_opportunities_status_check;
  END IF;
END $$;

ALTER TABLE public.commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_status_check
  CHECK (status IN (
    'solicitation','rfp','estimating','proposal_pending_approval',
    'proposal_sent','follow_up','won','lost',
    'inquiry','site_visit_scheduled','site_visit_done',
    'negotiating','on_hold','no_bid','reopened'
  ));

-- ═══════════════════════════════════════════════════════════════════
-- 4. Add previous_status snapshot column for reopened → solicitation
--    audit trail preservation. Idempotent.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS previous_status TEXT;

COMMENT ON COLUMN public.commercial_opportunities.previous_status IS
  'Snapshot of the prior status. Preserves reopened-from-what context
   after the CEO status model dropped reopened as a first-class value
   (Plan v1.1, 2026-07-09).';

-- ═══════════════════════════════════════════════════════════════════
-- 5. Clean up the mistaken lost_reason column if an earlier v1 draft
--    of this migration ran and created it. Safe no-op otherwise.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  DROP COLUMN IF EXISTS lost_reason;

-- ═══════════════════════════════════════════════════════════════════
-- 6. Backfill loss_reason='no_bid' BEFORE flipping the status so the
--    distinction survives.
-- ═══════════════════════════════════════════════════════════════════

UPDATE public.commercial_opportunities
   SET loss_reason = 'no_bid', updated_at = now()
 WHERE status = 'no_bid'
   AND (loss_reason IS NULL OR loss_reason <> 'no_bid');

-- ═══════════════════════════════════════════════════════════════════
-- 7. Backfill previous_status on existing reopened rows with a
--    sentinel value.
-- ═══════════════════════════════════════════════════════════════════

UPDATE public.commercial_opportunities
   SET previous_status = 'reopened_unknown_prior', updated_at = now()
 WHERE status = 'reopened'
   AND previous_status IS NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 8. Migrate historic status values to the CEO v1.1 enum.
--    Order chosen so any row moves exactly once. Now safe because
--    the widened CHECK accepts both old + new values.
-- ═══════════════════════════════════════════════════════════════════

UPDATE public.commercial_opportunities
   SET status = 'solicitation', updated_at = now()
 WHERE status IN ('inquiry', 'reopened');

UPDATE public.commercial_opportunities
   SET status = 'follow_up', updated_at = now()
 WHERE status IN ('negotiating', 'on_hold');

UPDATE public.commercial_opportunities
   SET status = 'lost', updated_at = now()
 WHERE status = 'no_bid';

-- Defense in depth: site_visit_* rows should already be migrated
-- to estimating by migration 044, but re-apply here so this migration
-- is safe standalone.
UPDATE public.commercial_opportunities
   SET status = 'estimating', updated_at = now()
 WHERE status IN ('site_visit_scheduled', 'site_visit_done');

-- ═══════════════════════════════════════════════════════════════════
-- 9. NARROW commercial_opportunities.status CHECK to just the 8 v1.1
--    values. Any row still on a v1.0 value would fail — the diagnostic
--    at step 11 catches those before we hit the narrow constraint.
-- ═══════════════════════════════════════════════════════════════════

-- Guard: if any row is still on a v1.0 value, don't narrow (the
-- narrow ALTER would fail and roll back the whole migration).
DO $$
DECLARE
  stray_count INT;
BEGIN
  SELECT COUNT(*) INTO stray_count
    FROM public.commercial_opportunities
   WHERE status NOT IN (
     'solicitation','rfp','estimating','proposal_pending_approval',
     'proposal_sent','follow_up','won','lost'
   );
  IF stray_count > 0 THEN
    RAISE EXCEPTION 'Migration 045: cannot narrow status CHECK — % rows still have a v1.0 value. Check the UPDATEs above.', stray_count;
  END IF;
END $$;

ALTER TABLE public.commercial_opportunities
  DROP CONSTRAINT commercial_opportunities_status_check;

ALTER TABLE public.commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_status_check
  CHECK (status IN (
    'solicitation','rfp','estimating','proposal_pending_approval',
    'proposal_sent','follow_up','won','lost'
  ));

-- ═══════════════════════════════════════════════════════════════════
-- 10. Flip the column DEFAULT from 'inquiry' (v1.0) to 'solicitation'
--     (v1.1). New rows without an explicit status now land on the
--     current default. Rerun-safe (SET DEFAULT is idempotent).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  ALTER COLUMN status SET DEFAULT 'solicitation';

-- ═══════════════════════════════════════════════════════════════════
-- 11. Final sanity notice — diagnostic-only (no failure).
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  total_opps INT;
BEGIN
  SELECT COUNT(*) INTO total_opps FROM public.commercial_opportunities;
  RAISE NOTICE 'Migration 045: complete. % opportunity rows migrated to Pre-Contract v1.1 enum.', total_opps;
END $$;

COMMIT;
