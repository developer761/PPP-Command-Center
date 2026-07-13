-- Migration 052 — Status Model v2 (Katie's Pre-Sale/Post-Sale two-level model).
--
-- Karan 2026-07-13: Katie sent an 8-status / 15-substatus model that replaces
-- the v1.1 flat 8-status enum from migration 045. Two lanes:
--
--   PRE-SALE:  Qualifying → Estimating → Proposal → Closed (Won/Lost)
--   POST-SALE: Pre-Construction → In Progress → Billing → Closed
--
-- Locked decisions (Karan 2026-07-13):
--   - "Estimating" is intentionally BOTH a Qualifying sub-status AND its own
--     Status (two workflow phases: assigned vs actively producing).
--   - `no_bid` stays as loss_reason under Closed/Lost (no change to Win/Loss reports).
--   - Won → Post-Sale is a MANUAL flip via "Start Project" button on the debrief
--     modal (not auto-advance).
--   - `follow_up_at` DATE + `follow_up_notes` TEXT ship as part of this refactor
--     (Katie's spec: "scheduled reminder dates, timestamps, and user notes").
--
-- Everything stays on `commercial_opportunities` — no separate projects table.
-- Alex flips the Won opp to `pre_construction`/`coordination` when project starts.
--
-- Follows the widen-CHECK / UPDATE / narrow-CHECK pattern from migration 045
-- so the migration is atomic and rerun-safe.
--
-- Backfill mapping (v1.1 → v2):
--   solicitation             → qualifying / solicitation
--   rfp                      → qualifying / rfp
--   estimating               → estimating / proposal_pending_approval
--   proposal_pending_approval→ estimating / proposal_pending_approval
--   proposal_sent            → proposal / sent
--   follow_up                → proposal / follow_up
--   won                      → pre_sale_closed / won
--   lost                     → pre_sale_closed / lost
--   (retired v1.0 fallbacks:)
--   inquiry / reopened       → qualifying / solicitation
--   negotiating / on_hold    → proposal / follow_up
--   no_bid                   → pre_sale_closed / lost (loss_reason='no_bid' preserved)
--   site_visit_scheduled     → qualifying / estimating
--   site_visit_done          → estimating / proposal_pending_approval

-- ═══════════════════════════════════════════════════════════════════
-- 1. Add `sub_status` column (nullable first — backfill populates it,
--    then narrow via CHECK below).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS sub_status TEXT;

-- ═══════════════════════════════════════════════════════════════════
-- 2. Add follow-up scheduling fields (Katie's ask).
--     - follow_up_at: DATE the reminder fires
--     - follow_up_notes: TEXT — what to do at that follow-up
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS follow_up_at DATE;

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS follow_up_notes TEXT;

-- ═══════════════════════════════════════════════════════════════════
-- 3. DROP status_log CHECK constraints entirely.
--    The log is append-only history — some existing rows already had
--    values (blank strings, unknown enums from earlier iterations) that
--    weren't in the v1.1 CHECK, and re-adding a widened CHECK fails
--    validation on those historic rows. App-layer writes valid values
--    going forward; no CHECK needed on history.
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
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'commercial_opportunity_status_log_to_status_check'
       AND conrelid = 'public.commercial_opportunity_status_log'::regclass
  ) THEN
    ALTER TABLE public.commercial_opportunity_status_log
      DROP CONSTRAINT commercial_opportunity_status_log_to_status_check;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- 4. TEMPORARILY WIDEN commercial_opportunities.status CHECK so backfill
--    UPDATEs can flip rows to v2 values before we narrow again.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  DROP CONSTRAINT IF EXISTS commercial_opportunities_status_check;

ALTER TABLE public.commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_status_check
  CHECK (status IN (
    -- v1.0 retired
    'inquiry','reopened','negotiating','on_hold','no_bid',
    'site_visit_scheduled','site_visit_done',
    -- v1.1
    'solicitation','rfp','estimating','proposal_pending_approval',
    'proposal_sent','follow_up','won','lost',
    -- v2
    'qualifying','proposal','pre_sale_closed',
    'pre_construction','in_progress','billing','post_sale_closed'
  ));

-- ═══════════════════════════════════════════════════════════════════
-- 5. BACKFILL every existing row into a (status, sub_status) tuple.
--    Ordered by desirability so the more-specific mappings run first.
-- ═══════════════════════════════════════════════════════════════════

-- solicitation → qualifying / solicitation
UPDATE public.commercial_opportunities
   SET status = 'qualifying', sub_status = 'solicitation', updated_at = now()
 WHERE status = 'solicitation';

-- rfp → qualifying / rfp
UPDATE public.commercial_opportunities
   SET status = 'qualifying', sub_status = 'rfp', updated_at = now()
 WHERE status = 'rfp';

-- estimating → estimating / proposal_pending_approval
UPDATE public.commercial_opportunities
   SET status = 'estimating', sub_status = 'proposal_pending_approval', updated_at = now()
 WHERE status = 'estimating' AND sub_status IS NULL;

-- proposal_pending_approval → estimating / proposal_pending_approval
UPDATE public.commercial_opportunities
   SET status = 'estimating', sub_status = 'proposal_pending_approval', updated_at = now()
 WHERE status = 'proposal_pending_approval';

-- proposal_sent → proposal / sent
UPDATE public.commercial_opportunities
   SET status = 'proposal', sub_status = 'sent', updated_at = now()
 WHERE status = 'proposal_sent';

-- follow_up → proposal / follow_up
UPDATE public.commercial_opportunities
   SET status = 'proposal', sub_status = 'follow_up', updated_at = now()
 WHERE status = 'follow_up';

-- won → pre_sale_closed / won
UPDATE public.commercial_opportunities
   SET status = 'pre_sale_closed', sub_status = 'won', updated_at = now()
 WHERE status = 'won';

-- lost → pre_sale_closed / lost
UPDATE public.commercial_opportunities
   SET status = 'pre_sale_closed', sub_status = 'lost', updated_at = now()
 WHERE status = 'lost';

-- Defense-in-depth: retired v1.0 values (any that slipped through migrations 044/045)
UPDATE public.commercial_opportunities
   SET status = 'qualifying', sub_status = 'solicitation', updated_at = now()
 WHERE status IN ('inquiry','reopened');

UPDATE public.commercial_opportunities
   SET status = 'proposal', sub_status = 'follow_up', updated_at = now()
 WHERE status IN ('negotiating','on_hold');

UPDATE public.commercial_opportunities
   SET status = 'pre_sale_closed', sub_status = 'lost', loss_reason = COALESCE(loss_reason, 'no_bid'), updated_at = now()
 WHERE status = 'no_bid';

UPDATE public.commercial_opportunities
   SET status = 'qualifying', sub_status = 'estimating', updated_at = now()
 WHERE status = 'site_visit_scheduled';

UPDATE public.commercial_opportunities
   SET status = 'estimating', sub_status = 'proposal_pending_approval', updated_at = now()
 WHERE status = 'site_visit_done';

-- Safety-net: if any row still has NULL sub_status (should not, but be defensive),
-- park it in qualifying/solicitation so the CHECK below doesn't fail.
UPDATE public.commercial_opportunities
   SET status = 'qualifying', sub_status = 'solicitation', updated_at = now()
 WHERE sub_status IS NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 6. GUARD: refuse to narrow the CHECK if any row is still on a v1 value.
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  stray_count INT;
BEGIN
  SELECT COUNT(*) INTO stray_count
    FROM public.commercial_opportunities
   WHERE status NOT IN (
     'qualifying','estimating','proposal','pre_sale_closed',
     'pre_construction','in_progress','billing','post_sale_closed'
   );
  IF stray_count > 0 THEN
    RAISE EXCEPTION 'Migration 052: cannot narrow status CHECK — % rows still have a v1 value. Check the UPDATEs above.', stray_count;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- 7. NARROW commercial_opportunities.status CHECK to the 8 v2 values.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  DROP CONSTRAINT commercial_opportunities_status_check;

ALTER TABLE public.commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_status_check
  CHECK (status IN (
    'qualifying','estimating','proposal','pre_sale_closed',
    'pre_construction','in_progress','billing','post_sale_closed'
  ));

-- ═══════════════════════════════════════════════════════════════════
-- 8. CHECK on sub_status — must be NON-NULL and must match its parent
--    status's allowed sub-status set.
--    Combined as a single CHECK so Postgres validates the tuple atomically.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_sub_status_check
  CHECK (
    sub_status IS NOT NULL AND (
      (status = 'qualifying'      AND sub_status IN ('solicitation','rfp','estimating')) OR
      (status = 'estimating'      AND sub_status IN ('proposal_pending_approval')) OR
      (status = 'proposal'        AND sub_status IN ('sent','follow_up')) OR
      (status = 'pre_sale_closed' AND sub_status IN ('won','lost')) OR
      (status = 'pre_construction' AND sub_status IN ('coordination','ready_to_mobilize')) OR
      (status = 'in_progress'     AND sub_status IN ('wip_on_site','wip_on_hold')) OR
      (status = 'billing'         AND sub_status IN ('substantial_completion','completed_and_invoiced')) OR
      (status = 'post_sale_closed' AND sub_status IN ('closeout','closed'))
    )
  );

-- ═══════════════════════════════════════════════════════════════════
-- 9. Flip DEFAULT from v1's 'solicitation' → v2's 'qualifying'.
--    New rows without explicit status now start in Qualifying/Solicitation
--    (which the app-layer sets on insert since the DB can't set two
--    columns from one DEFAULT).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  ALTER COLUMN status SET DEFAULT 'qualifying';

-- ═══════════════════════════════════════════════════════════════════
-- 10. Index on (status, sub_status) for Kanban rendering + filters.
--     Existing status-only indexes stay valid (leading-column match).
-- ═══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS commercial_opportunities_status_substatus_idx
  ON public.commercial_opportunities (status, sub_status)
  WHERE deleted_at IS NULL;

-- Follow-up date index for the daily cron that fires reminder bells.
CREATE INDEX IF NOT EXISTS commercial_opportunities_follow_up_at_idx
  ON public.commercial_opportunities (follow_up_at)
  WHERE deleted_at IS NULL AND follow_up_at IS NOT NULL;

COMMENT ON COLUMN public.commercial_opportunities.sub_status IS
  'Katie/Karan v2 status model (migration 052, 2026-07-13). Whitelisted per parent status via commercial_opportunities_sub_status_check.';

COMMENT ON COLUMN public.commercial_opportunities.follow_up_at IS
  'Scheduled follow-up date (Katie: "reminder dates, timestamps, and user notes"). Daily cron fires a bell notification on/after this date to whoever owns the opp.';

COMMENT ON COLUMN public.commercial_opportunities.follow_up_notes IS
  'Free-text notes about what to do at the scheduled follow-up. Only surfaced on the opp detail page + in the bell notification body.';
