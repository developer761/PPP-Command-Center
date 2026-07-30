-- 086_commercial_change_order_proposal_link.sql
-- Phase G v3 (Karan 2026-07-29) — link a Change Order to the proposal it amends.
--
-- Feedback: "there's no way to tell which proposal it's for." A project can
-- carry more than one proposal (base + revisions, or split scopes), so a CO
-- now optionally records WHICH proposal's scope it changes. Nullable — a CO
-- can still stand alone (general mid-job scope change with no single parent
-- proposal). ON DELETE SET NULL so removing a proposal doesn't orphan/destroy
-- the CO; the link simply clears.
--
-- Idempotent: safe to run more than once.

ALTER TABLE public.commercial_change_orders
  ADD COLUMN IF NOT EXISTS proposal_id UUID
    REFERENCES public.commercial_proposals(id) ON DELETE SET NULL;

-- Reverse lookup: given a proposal, which change orders amend it?
CREATE INDEX IF NOT EXISTS commercial_change_orders_proposal_idx
  ON public.commercial_change_orders (proposal_id) WHERE proposal_id IS NOT NULL;

COMMENT ON COLUMN public.commercial_change_orders.proposal_id IS
  'Phase G v3 — the proposal whose scope this CO amends (nullable). '
  'ON DELETE SET NULL: removing the proposal clears the link, keeps the CO.';
