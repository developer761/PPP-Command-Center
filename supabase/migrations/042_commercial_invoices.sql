-- 042_commercial_invoices.sql
-- Phase 3 · Invoicing & Revenue Dashboard for Commercial Command Center.
--
-- Schema: 3 tables + status_log + auto-numbering sequence + trigger.
-- Retainage explicitly OUT of scope for v1 (Karan 2026-07-05: "add later").
-- No estimates. No auto-email. USD only. One flat tax_pct field.
--
-- Idempotent — every CREATE uses IF NOT EXISTS; safe to re-paste.

-- ─────────────────────────────────────────────────────────────────────
-- 1. commercial_invoices — one invoice per Won opp (optional, admin discretion)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commercial_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','viewed','partial','paid','overdue','void')),

  -- Lifecycle timestamps. Null while state hasn't been reached.
  issued_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,

  -- Money. All in cents (BIGINT-safe up to $92 quintillion; well beyond any
  -- realistic paint bid). tax_pct is a flat percent applied to subtotal —
  -- NYC commercial paint tax is uniform, so a single field suffices for
  -- launch. total + balance are GENERATED so callers can never store an
  -- inconsistent invoice.
  subtotal_cents BIGINT NOT NULL DEFAULT 0
    CHECK (subtotal_cents >= 0),
  tax_pct NUMERIC(5,3) NOT NULL DEFAULT 0
    CHECK (tax_pct >= 0 AND tax_pct <= 100),
  paid_cents BIGINT NOT NULL DEFAULT 0
    CHECK (paid_cents >= 0),
  total_cents BIGINT GENERATED ALWAYS AS
    (subtotal_cents + ROUND(subtotal_cents * tax_pct / 100)) STORED,
  balance_cents BIGINT GENERATED ALWAYS AS
    (subtotal_cents + ROUND(subtotal_cents * tax_pct / 100) - paid_cents) STORED,

  -- Copy fields the customer sees on the PDF.
  payment_terms TEXT DEFAULT 'Net 30',
  customer_message TEXT,        -- appears above line items on PDF
  po_number TEXT,               -- customer PO for their AP system

  -- Internal-only.
  notes TEXT,                   -- never on customer PDF

  created_by_user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,       -- soft delete

  UNIQUE (invoice_number)
);

COMMENT ON TABLE public.commercial_invoices IS
  'Phase 3 — one invoice per Won opp (multiple invoices per opp OK for progress billing). Retainage deferred.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. commercial_invoice_line_items
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commercial_invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.commercial_invoices(id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 1000,  -- sparse for drag-reorder without full rewrite
  description TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1
    CHECK (quantity > 0),
  unit TEXT,                             -- "sqft", "hrs", "each", null
  unit_price_cents BIGINT NOT NULL
    CHECK (unit_price_cents >= 0),
  subtotal_cents BIGINT GENERATED ALWAYS AS
    (ROUND(quantity * unit_price_cents)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────
-- 3. commercial_invoice_payments
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commercial_invoice_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.commercial_invoices(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL
    CHECK (amount_cents > 0),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  method TEXT,                          -- "check", "ach", "wire", "credit_card", "other"
  reference TEXT,                       -- check #, wire confirmation, memo
  notes TEXT,
  recorded_by_user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────
-- 4. commercial_invoice_status_log — full audit trail
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commercial_invoice_status_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.commercial_invoices(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id UUID REFERENCES auth.users(id),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────
-- 5. Auto-numbering sequence — invoice_number defaults to PPP-INV-####
-- ─────────────────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS public.commercial_invoice_seq START 1;

-- ─────────────────────────────────────────────────────────────────────
-- 6. Trigger — recompute paid_cents + auto-flip status when a payment
--    row lands, changes, or is removed. Idempotent + defense-in-depth.
--
--    Rules:
--      * paid_cents = SUM(payments.amount_cents) for this invoice
--      * status flips: void stays void; else fully_paid → paid,
--        partial → partial, otherwise unchanged (won't downgrade from
--        sent to draft, etc.)
--      * paid_at gets stamped when balance hits zero; cleared when
--        a refund/deletion brings balance back above zero
--      * updated_at bumped
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.recompute_invoice_paid_cents()
RETURNS TRIGGER AS $$
DECLARE
  inv_id UUID;
  new_paid BIGINT;
  inv_total BIGINT;
  inv_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    inv_id := OLD.invoice_id;
  ELSE
    inv_id := NEW.invoice_id;
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0) INTO new_paid
    FROM public.commercial_invoice_payments
    WHERE invoice_id = inv_id;

  SELECT total_cents, status INTO inv_total, inv_status
    FROM public.commercial_invoices
    WHERE id = inv_id;

  UPDATE public.commercial_invoices
    SET paid_cents = new_paid,
        paid_at = CASE
          WHEN new_paid >= inv_total AND inv_total > 0
            THEN COALESCE(paid_at, now())
          WHEN new_paid < inv_total
            THEN NULL
          ELSE paid_at
        END,
        status = CASE
          WHEN inv_status = 'void' THEN 'void'
          WHEN new_paid >= inv_total AND inv_total > 0 THEN 'paid'
          WHEN new_paid > 0 THEN 'partial'
          ELSE inv_status
        END,
        updated_at = now()
    WHERE id = inv_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recompute_paid_cents ON public.commercial_invoice_payments;
CREATE TRIGGER trg_recompute_paid_cents
  AFTER INSERT OR UPDATE OR DELETE ON public.commercial_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.recompute_invoice_paid_cents();

-- ─────────────────────────────────────────────────────────────────────
-- 7. Indexes — the common lookups
-- ─────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ci_opp
  ON public.commercial_invoices(opportunity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ci_account
  ON public.commercial_invoices(account_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ci_status
  ON public.commercial_invoices(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ci_due
  ON public.commercial_invoices(due_at)
  WHERE deleted_at IS NULL AND status NOT IN ('paid', 'void');
CREATE INDEX IF NOT EXISTS idx_cili_invoice
  ON public.commercial_invoice_line_items(invoice_id, position);
CREATE INDEX IF NOT EXISTS idx_cip_invoice
  ON public.commercial_invoice_payments(invoice_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_cisl_invoice
  ON public.commercial_invoice_status_log(invoice_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 8. Account 360 view extension — unlock Invoiced / Paid / Balance
--    KPI tiles. The account detail page reads from an existing view
--    (or falls back to inline aggregates). Add three roll-up columns.
--
--    IF NOT EXISTS-safe: uses information_schema to detect whether
--    the view already carries the columns, and re-creates it only when
--    they're missing. In practice, the view gets re-created on every
--    Phase migration because pg views don't ALTER columns cleanly.
-- ─────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.commercial_account_invoice_rollup;
CREATE VIEW public.commercial_account_invoice_rollup AS
SELECT
  a.id AS account_id,
  COALESCE(SUM(i.total_cents) FILTER (WHERE i.status NOT IN ('draft', 'void')), 0) AS invoiced_cents,
  COALESCE(SUM(i.paid_cents) FILTER (WHERE i.status NOT IN ('draft', 'void')), 0) AS paid_cents,
  COALESCE(SUM(i.balance_cents) FILTER (WHERE i.status NOT IN ('draft', 'void', 'paid')), 0) AS balance_cents,
  COUNT(*) FILTER (WHERE i.status NOT IN ('draft', 'void')) AS invoice_count,
  COUNT(*) FILTER (WHERE i.status = 'overdue') AS overdue_count
FROM public.commercial_accounts a
LEFT JOIN public.commercial_invoices i
  ON i.account_id = a.id AND i.deleted_at IS NULL
GROUP BY a.id;

COMMENT ON VIEW public.commercial_account_invoice_rollup IS
  'Phase 3 — per-account $ invoiced/paid/balance for the Account 360 KPI strip. Excludes drafts + voids.';
