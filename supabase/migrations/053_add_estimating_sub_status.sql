-- Migration 053: Align v2 sub_status whitelist with Katie's spec.
--
-- Katie's 2026-07-13 status structure explicitly lists TWO sub-statuses
-- under the top-level `estimating` status:
--   - Estimating              (we're actively pricing)
--   - Proposal Pending Approval (priced, waiting on internal sign-off)
--
-- Migration 052 shipped with only 'proposal_pending_approval' — the
-- 'estimating' sub-status was missed on that pass. This migration
-- widens the tuple CHECK constraint to include (estimating, estimating).
--
-- Drop-and-re-add is safe because commercial_opportunities rows are
-- either already at (estimating, proposal_pending_approval) or won't
-- match the estimating branch at all — no data mutation needed.
-- Idempotent: DROP IF EXISTS then ADD CONSTRAINT.

ALTER TABLE public.commercial_opportunities
  DROP CONSTRAINT IF EXISTS commercial_opportunities_sub_status_check;

ALTER TABLE public.commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_sub_status_check
  CHECK (
    sub_status IS NOT NULL AND (
      (status = 'qualifying'      AND sub_status IN ('solicitation','rfp','estimating')) OR
      (status = 'estimating'      AND sub_status IN ('estimating','proposal_pending_approval')) OR
      (status = 'proposal'        AND sub_status IN ('sent','follow_up')) OR
      (status = 'pre_sale_closed' AND sub_status IN ('won','lost')) OR
      (status = 'pre_construction' AND sub_status IN ('coordination','ready_to_mobilize')) OR
      (status = 'in_progress'     AND sub_status IN ('wip_on_site','wip_on_hold')) OR
      (status = 'billing'         AND sub_status IN ('substantial_completion','completed_and_invoiced')) OR
      (status = 'post_sale_closed' AND sub_status IN ('closeout','closed'))
    )
  );
