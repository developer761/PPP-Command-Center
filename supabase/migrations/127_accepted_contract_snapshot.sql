-- 127: remember the signed contract ON THE DEAL.
--
-- Winning is recorded on the PROPOSAL, and creating a revision supersedes the
-- previous one. So the moment an estimator re-quotes a job the customer already
-- signed, no proposal reads `won` any more and the fact that $450k was agreed
-- disappears from the proposals table. The contract ladder then falls through to
-- "the newest proposal", which is the half-typed revision — and contract value,
-- gross margin, left-to-bill, the over-billed flag and the AIA "Original
-- Contract Sum" all quietly follow it.
--
-- The deal remembers the number instead. `commercial_invoices.
-- proposal_total_cents_at_bill` (migration 085) is the same idea already proven
-- here: freeze the number that matters at the moment it means something.
--
-- Deliberately NOT backfilled. A wrong value here silently and permanently
-- rewrites a real signed contract, so recovering the already-broken deals is a
-- separate, reviewed migration. The ladder's rung ordering protects them in the
-- meantime.
--
-- Safe to re-run.

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS accepted_contract_cents BIGINT;

-- Which proposal this came from, so the value can be traced back to a document
-- rather than being an unexplained number on the deal.
ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS accepted_contract_proposal_id UUID
  REFERENCES public.commercial_proposals(id) ON DELETE SET NULL;

-- When the win happened — NOT when this row was written. A reconcile pass
-- catching up weeks later must not claim the contract was agreed today.
ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS accepted_contract_set_at TIMESTAMPTZ;

-- Safe backfill: deals whose winning proposal is still intact. This is exact,
-- not inferred — the proposal is right there saying `won`. It gives every
-- correctly-recorded deal its snapshot immediately, so the protection starts
-- working before anyone re-quotes them.
UPDATE public.commercial_opportunities o
  SET accepted_contract_cents = w.total_cents,
      accepted_contract_proposal_id = w.id,
      accepted_contract_set_at = COALESCE(w.approved_at, w.updated_at)
  FROM (
    SELECT DISTINCT ON (opportunity_id)
           opportunity_id, id, total_cents, approved_at, updated_at
      FROM public.commercial_proposals
      WHERE status = 'won' AND deleted_at IS NULL
      ORDER BY opportunity_id, total_cents DESC
  ) w
  WHERE w.opportunity_id = o.id AND o.accepted_contract_cents IS NULL;
