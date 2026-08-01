-- 095 · Project purchases / job costs (Phase 2)
--
-- Cost side of a project (materials/labor/subs/equipment/permits). Feeds the Job
-- P&L (Contract - Costs = Gross Margin). Separate from invoicing.
--
-- Short single-statement CREATE (every line < 50 chars) so a paste tool that
-- hard-wraps long lines can't split/drop content. NOT NULL / CHECK / FK are
-- enforced in the app layer (service-role only), omitted here for paste safety.

CREATE TABLE IF NOT EXISTS public.commercial_project_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid,
  account_id uuid,
  category text DEFAULT 'materials',
  vendor text,
  amount_cents bigint,
  purchased_at timestamptz DEFAULT now(),
  description text,
  receipt_document_id uuid,
  created_by_user_id uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cpp_opp ON public.commercial_project_purchases (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_cpp_acct ON public.commercial_project_purchases (account_id);
