-- 095 · Project purchases / job costs (Phase 2)
--
-- Cost side of a project (materials/labor/subs/equipment/permits). Feeds the Job
-- P&L (Contract - Costs = Gross Margin). Separate from invoicing.
--
-- Every statement is ONE short line (<100 chars) and idempotent, so a paste tool
-- that drops or wraps lines can't corrupt it - just re-run the whole block and it
-- converges. The app sets all timestamps + enforces amount>0/category, so the
-- schema needs no DB defaults (except id) / CHECK / FK.

CREATE TABLE IF NOT EXISTS public.commercial_project_purchases (id uuid PRIMARY KEY);
ALTER TABLE public.commercial_project_purchases ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS opportunity_id uuid;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS account_id uuid;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS vendor text;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS amount_cents bigint;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS purchased_at timestamptz;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS receipt_document_id uuid;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE public.commercial_project_purchases ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_cpp_opp ON public.commercial_project_purchases (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_cpp_acct ON public.commercial_project_purchases (account_id);
