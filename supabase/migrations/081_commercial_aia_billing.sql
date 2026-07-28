-- 081_commercial_aia_billing.sql
-- Phase H — AIA progress billing (G702 Application & Certificate + G703
-- Continuation Sheet), per billing period on a post-sale Project (the
-- Opportunity), the same home Change Orders live on.
--
-- G702 (the summary certificate) is COMPUTED, not stored — its lines derive
-- from the application's contract snapshot + retainage + this application's
-- G703 lines + the prior applications:
--   1 Original Contract Sum          = original_contract_cents (snapshot here)
--   2 Net change by Change Orders    = netApprovedChangeOrderCents(opp) [Phase G]
--   3 Contract Sum to Date           = (1) + (2)
--   4 Total Completed & Stored       = Σ line (from_previous + this_period + stored)
--   5 Retainage                      = retainage_pct of (4)
--   6 Total Earned Less Retainage    = (4) − (5)
--   7 Less Previous Certificates     = Σ prior applications' current-payment-due
--   8 Current Payment Due            = (6) − (7)
--   9 Balance to Finish incl Retainage = (3) − (6)
-- So we store only the inputs: the contract snapshot, retainage %, the period,
-- and the G703 schedule-of-values lines.

CREATE TABLE IF NOT EXISTS public.commercial_aia_applications (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id       UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE RESTRICT,
  -- Denormalized (like invoices + change orders) for account-scoped queries.
  account_id           UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE RESTRICT,
  -- Sequential per project — AIA "Application No." (1, 2, 3 …). Assigned at
  -- insert (max+1); UNIQUE catches insert races.
  application_number   INTEGER NOT NULL,
  -- Billing period this certificate covers.
  period_from          DATE,
  period_to            DATE,
  -- Original Contract Sum (G702 line 1) snapshotted at creation so a later
  -- contract edit doesn't silently restate a submitted certificate. Change
  -- orders (line 2) are pulled live from the approved-CO sum (Phase G), which
  -- is what the AIA form expects (net changes are tracked separately).
  original_contract_cents BIGINT NOT NULL DEFAULT 0 CHECK (original_contract_cents >= 0),
  -- Retainage percent withheld (G702 line 5). AIA default is commonly 5% or 10%.
  retainage_pct        NUMERIC(5,2) NOT NULL DEFAULT 5.00 CHECK (retainage_pct >= 0 AND retainage_pct <= 100),
  -- draft → submitted (issued to the GC) → paid. Only non-draft applications
  -- count as "previous certificates" for later periods.
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'submitted', 'paid')),
  notes                TEXT,
  created_by_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (opportunity_id, application_number)
);

CREATE INDEX IF NOT EXISTS commercial_aia_applications_opp_idx
  ON public.commercial_aia_applications (opportunity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commercial_aia_applications_account_idx
  ON public.commercial_aia_applications (account_id) WHERE deleted_at IS NULL;

-- G703 Continuation Sheet — the schedule of values, one row per line item of
-- work, with this-period + stored progress. Scheduled values ideally seed from
-- the accepted proposal's line items, but are editable.
CREATE TABLE IF NOT EXISTS public.commercial_aia_line_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        UUID NOT NULL REFERENCES public.commercial_aia_applications(id) ON DELETE CASCADE,
  -- Sparse ordering (1000, 2000 …) so drag-reorder doesn't rewrite siblings.
  position              INTEGER NOT NULL DEFAULT 1000,
  -- G703 column A (item no.) + B (description of work).
  item_no               TEXT,
  description           TEXT NOT NULL DEFAULT '',
  -- C — Scheduled Value (this line's slice of the contract sum).
  scheduled_value_cents BIGINT NOT NULL DEFAULT 0 CHECK (scheduled_value_cents >= 0),
  -- D — Work completed from PREVIOUS applications (carry-forward).
  from_previous_cents   BIGINT NOT NULL DEFAULT 0 CHECK (from_previous_cents >= 0),
  -- E — Work completed THIS period.
  this_period_cents     BIGINT NOT NULL DEFAULT 0 CHECK (this_period_cents >= 0),
  -- F — Materials presently stored (not in D or E).
  materials_stored_cents BIGINT NOT NULL DEFAULT 0 CHECK (materials_stored_cents >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS commercial_aia_line_items_app_idx
  ON public.commercial_aia_line_items (application_id);

COMMENT ON TABLE public.commercial_aia_applications IS
  'Phase H — AIA G702 payment applications per billing period on a post-sale '
  'opportunity. G702 summary lines are computed from these inputs + approved '
  'change orders (Phase G) + prior applications.';

-- Service-role only (server actions use the service key), same as commercial_*.
ALTER TABLE public.commercial_aia_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_aia_line_items ENABLE ROW LEVEL SECURITY;
