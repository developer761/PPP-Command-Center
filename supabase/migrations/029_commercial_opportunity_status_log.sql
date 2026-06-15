-- Migration 029: Phase 2 Batch 2 — Opportunity status transition log.
--
-- Every status change on a commercial_opportunity gets a row here:
-- from_status (nullable on the create event), to_status, who changed
-- it, when, optional free-form note, optional loss_reason (REQUIRED by
-- the lib when to_status='lost' — DB can't enforce "non-empty" via
-- CHECK so the lib does it).
--
-- Drives:
--   - Detail page Timeline tab (Batch 3)
--   - "Days in current status" badge (Batch 3 — derived from MAX(changed_at) WHERE to_status = current)
--   - Win/loss-by-reason reports later phases
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.commercial_opportunity_status_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,

  -- from_status nullable so the initial create event has a row with
  -- from=NULL, to=initial-status. Status enum mirrors the opp table.
  from_status TEXT CHECK (from_status IS NULL OR from_status IN (
    'inquiry','site_visit_scheduled','site_visit_done','estimating',
    'proposal_sent','negotiating','on_hold','won','lost','no_bid','reopened'
  )),
  to_status TEXT NOT NULL CHECK (to_status IN (
    'inquiry','site_visit_scheduled','site_visit_done','estimating',
    'proposal_sent','negotiating','on_hold','won','lost','no_bid','reopened'
  )),

  changed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Free-form note. Optional in general; the lib REQUIRES non-empty
  -- when to_status='lost'.
  note TEXT,

  -- Loss reason — same enum as commercial_opportunities.loss_reason.
  -- The lib REQUIRES this to be non-null when to_status='lost'.
  loss_reason TEXT CHECK (loss_reason IS NULL OR loss_reason IN (
    'price','scope','timing','no_decision','awarded_to_competitor','relationship','other'
  ))
);

-- Hot paths:
-- 1. Full timeline for one opp (detail page Timeline tab)
CREATE INDEX IF NOT EXISTS commercial_opportunity_status_log_opp_idx
  ON public.commercial_opportunity_status_log (opportunity_id, changed_at DESC);

-- 2. Recent activity across all opps (Phase 2 future activity feed)
CREATE INDEX IF NOT EXISTS commercial_opportunity_status_log_changed_at_idx
  ON public.commercial_opportunity_status_log (changed_at DESC);

-- 3. Closed-deal reporting (won/lost/no_bid)
CREATE INDEX IF NOT EXISTS commercial_opportunity_status_log_closed_idx
  ON public.commercial_opportunity_status_log (to_status, changed_at DESC)
  WHERE to_status IN ('won', 'lost', 'no_bid');
