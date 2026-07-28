-- 080_commercial_change_orders.sql
-- Phase G — Change Orders on a post-contract Project.
--
-- In this platform the "Project" is the Opportunity in its post-sale (Won)
-- state — there is no separate projects table (see 046: the planned
-- commercial_projects split never happened; invoices already attach to the
-- opportunity). Change Orders attach the same way.
--
-- A Change Order is additional (or deducted) scope agreed mid-job:
--   • amount_cents is SIGNED — positive = added scope, negative = deduct/credit.
--   • status flows pending → approved | declined (approval is a manager gate).
--   • An APPROVED CO adjusts the AIA "contract sum to date" (Phase H consumes
--     the net-approved sum). A DECLINED or pending CO must NOT touch that math.
--   • A CO is billed as its OWN invoice (never folded into the base contract
--     invoice), linked back via invoiced_invoice_id. That column is also the
--     double-bill guard — a CO with a live invoice can't be billed again.

CREATE TABLE IF NOT EXISTS public.commercial_change_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id      UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE RESTRICT,
  -- Denormalized (like commercial_invoices) so account-scoped queries + the
  -- "bill this CO" invoice creation don't need a join back to the opp.
  account_id          UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE RESTRICT,
  -- Sequential per-opportunity number (CO-001, CO-002 …) for human reference
  -- and the AIA G703 continuation sheet. Assigned at insert (max+1); the
  -- UNIQUE(opportunity_id, co_number) constraint catches insert races.
  co_number           INTEGER NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  -- SIGNED cents. Positive = additive scope, negative = deduct/credit.
  -- Zero is meaningless for a CO, so it's blocked.
  amount_cents        BIGINT NOT NULL CHECK (amount_cents <> 0),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'declined')),
  -- Who approved/declined + when (audit; also gates billing — only approved
  -- COs can be billed).
  decided_by_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at          TIMESTAMPTZ,
  -- The invoice that bills this CO. NULL until billed. Guards double-billing:
  -- the app blocks a second bill when this points at a live (non-deleted)
  -- invoice. ON DELETE SET NULL so hard-deleting the invoice frees the CO to
  -- be re-billed; soft-delete is handled in the app (a soft-deleted invoice
  -- counts as "not billed").
  invoiced_invoice_id UUID REFERENCES public.commercial_invoices(id) ON DELETE SET NULL,
  created_by_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Soft-delete, consistent with the rest of the commercial schema.
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (opportunity_id, co_number)
);

-- List COs for a project (the opp detail Change Orders tab), live rows only.
CREATE INDEX IF NOT EXISTS commercial_change_orders_opp_idx
  ON public.commercial_change_orders (opportunity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commercial_change_orders_account_idx
  ON public.commercial_change_orders (account_id) WHERE deleted_at IS NULL;
-- Reverse lookup: given an invoice, which CO does it bill?
CREATE INDEX IF NOT EXISTS commercial_change_orders_invoice_idx
  ON public.commercial_change_orders (invoiced_invoice_id) WHERE invoiced_invoice_id IS NOT NULL;

COMMENT ON TABLE public.commercial_change_orders IS
  'Phase G — signed change orders on a post-sale opportunity (the Project). '
  'Approved COs feed the AIA net-change-orders math (Phase H); each is billed '
  'as its own invoice via invoiced_invoice_id (also the double-bill guard).';

-- Service-role only (crons + server actions use the service key). RLS denies
-- all direct anon/authenticated access, same as the rest of commercial_*.
ALTER TABLE public.commercial_change_orders ENABLE ROW LEVEL SECURITY;
