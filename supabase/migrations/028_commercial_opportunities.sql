-- Migration 028: Phase 2 Batch 1 — Opportunity Pipeline foundation.
--
-- The deal record. From "Sarah from St. Joseph's emailed asking for a
-- bid" through "Won." Estimating (Phase 3) hangs off this; Project
-- Setup (Phase 4) starts when Won.
--
-- Scope locked in docs/PHASE_2_OPPORTUNITY_SCOPE.md (9-status DAG,
-- low/high cents BIGINT bid, USD only, soft-delete, primary contact
-- auto-populate, multi-team via separate table in 029, plans+specs
-- via separate bucket in 031).
--
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS public.commercial_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent account. ON DELETE RESTRICT — accounts that have opps must
  -- be soft-deleted first; never hard-delete an account that has
  -- bid history.
  account_id UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE RESTRICT,

  -- Primary contact at the customer side. Auto-populates from
  -- commercial_account_contacts where is_primary=TRUE at create time
  -- (lib), user can override per-opp. SET NULL if the contact is
  -- soft-deleted later — the opp stays alive.
  primary_contact_id UUID REFERENCES public.commercial_contacts(id) ON DELETE SET NULL,

  -- Display title for the deal ("Lobby + Halls Repaint", "Q3 Site Refresh").
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),

  -- Optional longer-form description / scope summary.
  description TEXT,

  -- 9-status DAG + reopened (rare; for won deals that come back). TEXT
  -- + CHECK matches Phase 1 pattern (rating, compliance, role, etc.).
  status TEXT NOT NULL DEFAULT 'inquiry' CHECK (status IN (
    'inquiry',
    'site_visit_scheduled',
    'site_visit_done',
    'estimating',
    'proposal_sent',
    'negotiating',
    'on_hold',
    'won',
    'lost',
    'no_bid',
    'reopened'
  )),

  -- Bid value in CENTS (BIGINT — dodges float rounding). Either can be
  -- NULL for an early-stage inquiry; equal low=high for a firm number;
  -- low<high for a range. CHECK enforces ordering when both present.
  bid_value_low_cents BIGINT,
  bid_value_high_cents BIGINT,
  CHECK (
    bid_value_low_cents IS NULL
    OR bid_value_high_cents IS NULL
    OR bid_value_low_cents <= bid_value_high_cents
  ),

  -- Win probability 0-100. Default 10 (matches the 'inquiry' default
  -- status). Lib sets per-status defaults on status change. User can
  -- override per-opp ("this is a sure thing" → 95).
  probability_pct INT NOT NULL DEFAULT 10
    CHECK (probability_pct BETWEEN 0 AND 100),

  -- Source of the lead. Drives win/loss-by-source reporting later.
  source TEXT CHECK (source IS NULL OR source IN (
    'email',
    'phone',
    'web',
    'plans_room',
    'repeat',
    'referral',
    'other'
  )),

  -- Dates as DATE not TIMESTAMPTZ — time-of-day is irrelevant for "due
  -- date" / "decision date" and DATE dodges midnight-TZ edge cases.
  -- proposal_due_at drives the hot-deal threshold + the countdown badge.
  proposed_start_at DATE,
  proposed_end_at DATE,
  proposal_due_at DATE,
  decided_at DATE,

  -- Loss tracking — required by the lib when status=lost (not enforced
  -- in SQL because the status_log captures the full transition with
  -- its own required-reason on lost; this row just mirrors the latest
  -- value for quick filter/report).
  loss_reason TEXT CHECK (loss_reason IS NULL OR loss_reason IN (
    'price',
    'scope',
    'timing',
    'no_decision',
    'awarded_to_competitor',
    'relationship',
    'other'
  )),
  loss_notes TEXT,

  -- Audit + soft-delete (mirror Phase 1 accounts).
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);

-- ============================================================
-- Indexes — every WHERE-clause field gets one.
-- ============================================================

-- List opps for an account (the Account "Opportunities" tab + the
-- account 360 overview view's opp counts). Excludes soft-deleted.
CREATE INDEX IF NOT EXISTS commercial_opportunities_account_active_idx
  ON public.commercial_opportunities (account_id, status)
  WHERE deleted_at IS NULL;

-- Status filter on the global list page (chips + Kanban). Excludes
-- soft-deleted.
CREATE INDEX IF NOT EXISTS commercial_opportunities_status_idx
  ON public.commercial_opportunities (status)
  WHERE deleted_at IS NULL;

-- Hot-deal index: high bid value + near decision date + in active
-- negotiation. Powers the "hot" chip filter. Partial so it only
-- indexes the ~5% of opps that qualify, keeping the index tiny.
CREATE INDEX IF NOT EXISTS commercial_opportunities_hot_idx
  ON public.commercial_opportunities (proposal_due_at, bid_value_high_cents)
  WHERE deleted_at IS NULL
    AND status IN ('estimating', 'proposal_sent', 'negotiating');

-- "All opps for this contact" lookup (rare query, but cheap to index
-- since it's already a single column with a partial filter).
CREATE INDEX IF NOT EXISTS commercial_opportunities_contact_idx
  ON public.commercial_opportunities (primary_contact_id)
  WHERE deleted_at IS NULL;

-- Activity sort (most recently updated first — drives the default
-- ordering on the list page).
CREATE INDEX IF NOT EXISTS commercial_opportunities_updated_idx
  ON public.commercial_opportunities (updated_at DESC)
  WHERE deleted_at IS NULL;

-- ============================================================
-- updated_at trigger (reuse Phase 1 function from migration 020).
-- ============================================================
DROP TRIGGER IF EXISTS commercial_opportunities_set_updated_at
  ON public.commercial_opportunities;
CREATE TRIGGER commercial_opportunities_set_updated_at
  BEFORE UPDATE ON public.commercial_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();
