-- Migration 085: link a progress invoice to the accepted proposal it bills.
--
-- One accepted (won) proposal is the signed contract; you bill it in chunks
-- (progress invoices). Cardinality is one proposal → many invoices, so the FK
-- lives on the MANY side (the invoice). Grouping invoices by proposal_id gives
-- the parent→children view ("Proposal $X — billed $Y across N invoices, $Z
-- left"). Change-order invoices carry proposal_id = NULL, so they naturally
-- fall outside the proposal's billed-vs-contract math.
--
-- The "portion billed" is emergent, never stored: SUM(invoice totals with this
-- proposal_id, not void) ÷ proposal total — so it can't drift. We DO snapshot
-- the proposal total at bill time as a defensive denominator (won proposals are
-- already frozen, but the snapshot survives a later hard-delete of the parent).
--
-- ON DELETE SET NULL (mirrors the change-order link) — deleting a proposal frees
-- its invoices rather than cascading a money-record delete. Idempotent.

ALTER TABLE public.commercial_invoices
  ADD COLUMN IF NOT EXISTS proposal_id UUID
    REFERENCES public.commercial_proposals(id) ON DELETE SET NULL;

ALTER TABLE public.commercial_invoices
  ADD COLUMN IF NOT EXISTS proposal_total_cents_at_bill BIGINT;

CREATE INDEX IF NOT EXISTS idx_ci_proposal
  ON public.commercial_invoices(proposal_id)
  WHERE deleted_at IS NULL AND proposal_id IS NOT NULL;
