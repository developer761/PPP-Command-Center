-- Migration 030: Phase 2 Batch 3 — PPP staff assignments per Opportunity.
--
-- Mirrors commercial_account_assignments (migration 021) — same is_primary
-- partial UNIQUE pattern + removed_at soft-delete + audit columns. Role
-- enum is OPPORTUNITY-SPECIFIC: opps need pre-bid/execution roles
-- (lead_estimator, sales_rep, primary_pm, superintendent), not the
-- account-level billing/foreman roles.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.commercial_opportunity_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  role TEXT NOT NULL CHECK (role IN (
    'sales_rep',
    'lead_estimator',
    'primary_pm',
    'superintendent',
    'other'
  )),

  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,

  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Soft-delete via removed_at so audit history of who-worked-on-what
  -- stays queryable when someone rolls off.
  removed_at TIMESTAMPTZ,
  removed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  UNIQUE (opportunity_id, user_id, role)
);

-- Hot path: "the current team for this opp"
CREATE INDEX IF NOT EXISTS commercial_opportunity_assignments_opp_active_idx
  ON public.commercial_opportunity_assignments (opportunity_id)
  WHERE removed_at IS NULL;

-- Hot path: "every opp this user is on" (for future "my opps" surfaces)
CREATE INDEX IF NOT EXISTS commercial_opportunity_assignments_user_active_idx
  ON public.commercial_opportunity_assignments (user_id)
  WHERE removed_at IS NULL;

-- Enforce at-most-one is_primary per (opportunity, role) at a time.
-- Same pattern as accounts (migration 021).
CREATE UNIQUE INDEX IF NOT EXISTS commercial_opportunity_assignments_primary_idx
  ON public.commercial_opportunity_assignments (opportunity_id, role)
  WHERE is_primary = TRUE AND removed_at IS NULL;
