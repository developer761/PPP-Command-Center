-- 090 · Invoice milestones (2026-08, Karan smoke-test rework)
--
-- Model flip: a DEAL has one (or more) invoices; an invoice can be broken into
-- MILESTONES — a Schedule-of-Values breakdown WITHIN that invoice. e.g. a
-- $10,000 invoice split into 4 × $2,500, each with its own NAME, DUE DATE and
-- LIEN WAIVER. Milestones are OPTIONAL (a flat invoice has none).
--
-- Consistency rule (why this can't drift): every milestone pairs 1:1 with an
-- invoice line item (`line_item_id`). Milestone amount == its line item's
-- subtotal, so the invoice total (Σ line items) ALWAYS equals Σ milestones —
-- there is no separate stored total to reconcile. KPIs stay invoice-level and
-- unchanged; milestones only layer scheduling + lien-waiver metadata on top.
--
-- Forward compatibility:
--   * AIA G703 — milestones ARE the schedule-of-values lines (name = description,
--     amount = scheduled value).
--   * Change Orders — a billed CO adds a milestone (+ paired line item) to the
--     deal's invoice; `change_order_id` links it back.
--   * Payments-per-milestone (future) — a payment can later carry a milestone_id;
--     not modeled yet (payments stay invoice-level for now).
--
-- Idempotent — safe to re-paste.

CREATE TABLE IF NOT EXISTS public.commercial_invoice_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL
    REFERENCES public.commercial_invoices(id) ON DELETE CASCADE,

  -- Display order within the invoice (sparse for reorder without full rewrite).
  position INT NOT NULL DEFAULT 1000,

  -- What this milestone bills for + how much (pre-tax, mirrors the line item).
  name TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),

  -- When this milestone's payment is expected. Null = no schedule date.
  due_at TIMESTAMPTZ,

  -- The paired invoice line item (the actual charge). SET NULL if the line item
  -- is removed directly — the milestone then reads as an unlinked schedule row
  -- until reconciled/deleted.
  line_item_id UUID
    REFERENCES public.commercial_invoice_line_items(id) ON DELETE SET NULL,

  -- Per-milestone stored lien waiver (parent_type=opportunity, category=
  -- lien_waiver document). Null until the signed waiver is uploaded.
  lien_waiver_document_id UUID,

  -- When this milestone was created by billing a change order, the CO it came
  -- from. Null for ordinary milestones. SET NULL if the CO is later deleted.
  change_order_id UUID
    REFERENCES public.commercial_change_orders(id) ON DELETE SET NULL,

  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

COMMENT ON TABLE public.commercial_invoice_milestones IS
  '2026-08 — optional Schedule-of-Values breakdown of an invoice; each row pairs 1:1 with a line item and adds a due date + lien waiver. Sum of milestones == invoice total by construction.';

CREATE INDEX IF NOT EXISTS idx_cim_invoice
  ON public.commercial_invoice_milestones(invoice_id, position)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cim_change_order
  ON public.commercial_invoice_milestones(change_order_id)
  WHERE deleted_at IS NULL AND change_order_id IS NOT NULL;
