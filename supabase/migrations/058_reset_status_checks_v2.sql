-- Migration 058: idempotent reset of the commercial_opportunities
-- status + sub_status CHECK constraints to the v2 enum.
--
-- Karan 2026-07-15: dragging a Won card on the kanban surfaces
--   "new row for relation commercial_opportunities violates check
--    constraint commercial_opportunities_status_check"
--
-- Root cause candidates:
--   (a) migration 052 (v2 status model) was never pasted, so the DB
--       still has migration 045's v1.1 CHECK whitelist that rejects
--       v2 values like 'proposal', 'pre_sale_closed', 'pre_construction'.
--   (b) 052 was pasted but a row from an earlier migration is still
--       carrying a v1.1 value that gets echoed back on save.
--
-- This migration handles both — it's fully idempotent, safe to re-paste,
-- and doesn't assume any particular starting state:
--   1. Drops the current status + sub_status CHECKs so backfill won't
--      trip the old whitelist.
--   2. Backfills any lingering v1.1 status values into their v2
--      equivalents (tuple form).
--   3. Re-adds the v2 CHECKs (matches migration 052 + 053 combined).
--
-- If the DB is already fully on v2, steps 1 + 3 are no-ops of
-- practical effect (DROP + re-ADD the same CHECK) and step 2's
-- UPDATEs match zero rows.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════
-- 1. Drop existing CHECKs (safe to skip if missing)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  DROP CONSTRAINT IF EXISTS commercial_opportunities_status_check;
ALTER TABLE public.commercial_opportunities
  DROP CONSTRAINT IF EXISTS commercial_opportunities_sub_status_check;

-- ═══════════════════════════════════════════════════════════════════
-- 2. Backfill any v1.0 / v1.1 status values into v2 (status, sub_status)
--    tuples. All UPDATEs are conditional so they match zero rows on a
--    fully-migrated DB.
-- ═══════════════════════════════════════════════════════════════════

-- v1.0 legacy → v2
UPDATE public.commercial_opportunities
   SET status = 'qualifying', sub_status = COALESCE(sub_status, 'solicitation')
 WHERE status IN ('inquiry','reopened');

UPDATE public.commercial_opportunities
   SET status = 'proposal', sub_status = COALESCE(sub_status, 'follow_up')
 WHERE status IN ('negotiating','on_hold');

-- v1.1 → v2
UPDATE public.commercial_opportunities
   SET status = 'qualifying', sub_status = 'solicitation'
 WHERE status = 'solicitation';

UPDATE public.commercial_opportunities
   SET status = 'qualifying', sub_status = 'rfp'
 WHERE status = 'rfp';

-- v1.1 'estimating' is already a valid v2 status; just ensure sub_status
-- is populated (default to 'estimating' to preserve intent when null).
UPDATE public.commercial_opportunities
   SET sub_status = 'estimating'
 WHERE status = 'estimating' AND (sub_status IS NULL OR sub_status = '');

UPDATE public.commercial_opportunities
   SET status = 'estimating', sub_status = 'proposal_pending_approval'
 WHERE status = 'proposal_pending_approval';

UPDATE public.commercial_opportunities
   SET status = 'proposal', sub_status = 'sent'
 WHERE status = 'proposal_sent';

-- v1.1 'follow_up' → v2 (proposal, follow_up)
UPDATE public.commercial_opportunities
   SET status = 'proposal', sub_status = 'follow_up'
 WHERE status = 'follow_up';

-- v1.1 won/lost → v2 (pre_sale_closed, won|lost)
UPDATE public.commercial_opportunities
   SET status = 'pre_sale_closed', sub_status = 'won'
 WHERE status = 'won';

UPDATE public.commercial_opportunities
   SET status = 'pre_sale_closed', sub_status = 'lost'
 WHERE status = 'lost';

-- Any orphaned sub_status = NULL under an otherwise-valid v2 status:
-- fill with the sensible default so the tuple CHECK below doesn't reject.
UPDATE public.commercial_opportunities SET sub_status = 'solicitation'
  WHERE status = 'qualifying' AND (sub_status IS NULL OR sub_status = '');
UPDATE public.commercial_opportunities SET sub_status = 'sent'
  WHERE status = 'proposal' AND (sub_status IS NULL OR sub_status = '');
UPDATE public.commercial_opportunities SET sub_status = 'won'
  WHERE status = 'pre_sale_closed' AND (sub_status IS NULL OR sub_status = '');
UPDATE public.commercial_opportunities SET sub_status = 'coordination'
  WHERE status = 'pre_construction' AND (sub_status IS NULL OR sub_status = '');
UPDATE public.commercial_opportunities SET sub_status = 'wip_on_site'
  WHERE status = 'in_progress' AND (sub_status IS NULL OR sub_status = '');
UPDATE public.commercial_opportunities SET sub_status = 'substantial_completion'
  WHERE status = 'billing' AND (sub_status IS NULL OR sub_status = '');
UPDATE public.commercial_opportunities SET sub_status = 'closeout'
  WHERE status = 'post_sale_closed' AND (sub_status IS NULL OR sub_status = '');

-- ═══════════════════════════════════════════════════════════════════
-- 3. Re-add the v2 CHECKs. status enum matches migration 052; sub_status
--    tuple matches migration 053 (which added 'estimating' under
--    status='estimating').
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_status_check
  CHECK (status IN (
    'qualifying','estimating','proposal','pre_sale_closed',
    'pre_construction','in_progress','billing','post_sale_closed'
  ));

ALTER TABLE public.commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_sub_status_check
  CHECK (
    sub_status IS NOT NULL AND (
      (status = 'qualifying'       AND sub_status IN ('solicitation','rfp','estimating')) OR
      (status = 'estimating'       AND sub_status IN ('estimating','proposal_pending_approval')) OR
      (status = 'proposal'         AND sub_status IN ('sent','follow_up')) OR
      (status = 'pre_sale_closed'  AND sub_status IN ('won','lost')) OR
      (status = 'pre_construction' AND sub_status IN ('coordination','ready_to_mobilize')) OR
      (status = 'in_progress'      AND sub_status IN ('wip_on_site','wip_on_hold')) OR
      (status = 'billing'          AND sub_status IN ('substantial_completion','completed_and_invoiced')) OR
      (status = 'post_sale_closed' AND sub_status IN ('closeout','closed'))
    )
  );

-- ═══════════════════════════════════════════════════════════════════
-- 4. Diagnostic notice — how many rows are on each (status, sub_status)
--    tuple after this migration. Read the notice from the Supabase
--    SQL Editor output to confirm the backfill did what you expected.
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  r RECORD;
BEGIN
  RAISE NOTICE 'Migration 058: status distribution after reset:';
  FOR r IN
    SELECT status, sub_status, COUNT(*) AS n
      FROM public.commercial_opportunities
     GROUP BY status, sub_status
     ORDER BY status, sub_status
  LOOP
    RAISE NOTICE '  (%, %) → % row(s)', r.status, r.sub_status, r.n;
  END LOOP;
END $$;

COMMIT;
