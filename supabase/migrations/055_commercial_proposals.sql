-- Migration 055: Proposals + Proposal Line Items (Phase F.1).
--
-- Katie's 2026-07-13 spec: Alex writes ~1 proposal per bid, sometimes
-- multiple revisions. Every proposal ties to an opportunity, pulls
-- line items from the Phase D product library, uses standard Tomco
-- header/intro/exclusions, and renders as a PDF that matches the
-- canonical Tomco format extracted from 5 real 2026 proposals.
--
-- Structure:
--   * commercial_proposals — header + rollup + status + snapshot doc ref
--   * commercial_proposal_line_items — inclusions AND alternates
--     (is_alternate flag). Snapshotted unit_price_cents so a later
--     Product edit doesn't rewrite a sent proposal.
--
-- Idempotent (IF NOT EXISTS + IF NOT EXISTS on indexes + OR REPLACE
-- on trigger + function). Safe to rerun.

-- ═══════════════════════════════════════════════════════════════════
-- 1. commercial_proposals — header + rollup
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.commercial_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL
    REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,

  -- R1, R2, R3... one revision chain per opportunity.
  revision_number INTEGER NOT NULL DEFAULT 1 CHECK (revision_number >= 1),
  parent_proposal_id UUID
    REFERENCES public.commercial_proposals(id) ON DELETE SET NULL,

  -- Header block cached from account + deal at create time so PDF
  -- snapshots don't shift if the source data is edited later.
  -- Shape: { gc_company, gc_address_lines[], attention, phone, email,
  --          project_name, project_address, date_iso, show_capital_improvement_notice }
  header_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Body overrides — null = fall back to Tomco defaults in the
  -- render layer (lib/commercial/proposals/constants.ts).
  intro_text_override TEXT,
  alternate_notes TEXT,
  bid_notes TEXT,  -- hidden on PDF unless populated

  -- Exclusion references (UUID array — pulled from Phase F.0 library).
  exclusion_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],

  -- Rollup — sum of line items with is_alternate = false. Cents.
  -- Recomputed by lib on every line-item mutation (no DB trigger; keeps
  -- the write path predictable + easy to reason about).
  total_cents BIGINT NOT NULL DEFAULT 0,

  -- Rendering mode: Tomco convention hides per-line prices on the
  -- customer PDF (single TOTAL only). Toggle per proposal.
  pdf_show_line_prices BOOLEAN NOT NULL DEFAULT false,

  -- Estimator sign-off snapshot at create time (name + phone + email
  -- captured so the PDF footer stays stable if the estimator's contact
  -- info changes later).
  estimator_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Lifecycle. draft → pending_approval → sent → won/lost/expired.
  -- superseded fires when a newer revision is created.
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft','pending_approval','sent','won','lost','expired','superseded'
    )),
  sent_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,

  -- Snapshot Document ref (set on Send — the PDF gets uploaded to the
  -- Documents tab as kind='proposal' + linked back here).
  snapshot_document_id UUID
    REFERENCES public.commercial_documents(id) ON DELETE SET NULL,

  -- Audit.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS commercial_proposals_opp_idx
  ON public.commercial_proposals (opportunity_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS commercial_proposals_status_idx
  ON public.commercial_proposals (status)
  WHERE deleted_at IS NULL;

-- One revision number per opportunity — reruns of "bump revision"
-- pick the max + 1, but the unique index catches a race.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_proposals_opp_rev_uniq
  ON public.commercial_proposals (opportunity_id, revision_number)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.set_updated_at_commercial_proposals()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_commercial_proposals_updated_at ON public.commercial_proposals;
CREATE TRIGGER trg_commercial_proposals_updated_at
  BEFORE UPDATE ON public.commercial_proposals
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_commercial_proposals();

-- ═══════════════════════════════════════════════════════════════════
-- 2. commercial_proposal_line_items — inclusions + alternates
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.commercial_proposal_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL
    REFERENCES public.commercial_proposals(id) ON DELETE CASCADE,

  -- Optional FK back to the source Product row. Nullable so a proposal
  -- can carry a one-off line item without needing a catalog entry.
  -- ON DELETE SET NULL because deleting a Product must never rewrite
  -- historical proposals — the snapshot fields below are the truth.
  product_id UUID
    REFERENCES public.commercial_products(id) ON DELETE SET NULL,

  -- Snapshotted at create time. Editing the source Product later does
  -- NOT propagate to sent proposals — the estimator's frozen intent
  -- is what got sent to the customer.
  description TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  unit_price_cents BIGINT NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),

  -- Alternates render in a separate PDF section + are EXCLUDED from
  -- the proposal TOTAL rollup.
  is_alternate BOOLEAN NOT NULL DEFAULT false,

  -- Sort key within the proposal (drag-reorder from the editor).
  position INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commercial_proposal_line_items_proposal_idx
  ON public.commercial_proposal_line_items (proposal_id, position);

CREATE OR REPLACE FUNCTION public.set_updated_at_commercial_proposal_line_items()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_commercial_proposal_line_items_updated_at
  ON public.commercial_proposal_line_items;
CREATE TRIGGER trg_commercial_proposal_line_items_updated_at
  BEFORE UPDATE ON public.commercial_proposal_line_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_commercial_proposal_line_items();
