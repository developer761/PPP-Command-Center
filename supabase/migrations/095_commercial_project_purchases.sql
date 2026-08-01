-- 095 · Project purchases / job costs (Phase 2)
--
-- The COST side of a project: money OUT - materials, labor, subs, equipment,
-- permits. Feeds the Job P&L (Contract - Costs = Gross Margin). Kept separate
-- from invoicing - what we charge the customer never changes with cost.
--
-- Rewritten as one statement per line (shell + ADD COLUMN IF NOT EXISTS) so a
-- copy-paste can't drop a middle line and break the whole CREATE. Fully
-- idempotent - safe to re-paste any number of times, and self-heals a partial
-- table from an earlier failed paste. CHECK/FK are enforced in the app layer
-- (service-role only), so they're intentionally omitted here for paste safety.

CREATE TABLE IF NOT EXISTS public.commercial_project_purchases (id UUID PRIMARY KEY DEFAULT gen_random_uuid());

ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS opportunity_id UUID;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'materials';
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS vendor TEXT;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS amount_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS receipt_document_id UUID;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cpp_opportunity ON public.commercial_project_purchases(opportunity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cpp_account ON public.commercial_project_purchases(account_id) WHERE deleted_at IS NULL;
