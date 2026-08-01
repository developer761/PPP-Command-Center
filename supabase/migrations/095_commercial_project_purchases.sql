-- 095 · Project purchases / job costs (Phase 2)
--
-- The COST side of a project (= post-sale opportunity): money OUT — materials,
-- labor payments, subcontractors, equipment, permits. Feeds the Job P&L
-- (Contract - Costs = Gross Margin). Revenue lives entirely on the invoices;
-- this is kept separate - what we charge the customer never changes with cost.
--
-- Service-role only (commercialDb()); no RLS, app-enforced access.
-- Idempotent - safe to re-paste. CHECKs are table-level named constraints so a
-- copy-paste can't drop a wrapped column-constraint line.

CREATE TABLE IF NOT EXISTS public.commercial_project_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'materials',
  vendor TEXT,
  amount_cents BIGINT NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT,
  receipt_document_id UUID,
  created_by_user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT commercial_project_purchases_category_check
    CHECK (category IN ('materials','labor','subcontractor','equipment','permit','other')),
  CONSTRAINT commercial_project_purchases_amount_check
    CHECK (amount_cents > 0)
);

COMMENT ON TABLE public.commercial_project_purchases IS
  'Phase 2 - cost side of a project (materials/labor/subs/equipment/permits) tagged to an opportunity. Feeds Job P&L gross margin. Never affects invoice / customer billing.';

CREATE INDEX IF NOT EXISTS idx_cpp_opportunity
  ON public.commercial_project_purchases(opportunity_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cpp_account
  ON public.commercial_project_purchases(account_id)
  WHERE deleted_at IS NULL;
