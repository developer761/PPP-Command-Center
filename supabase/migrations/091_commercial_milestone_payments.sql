-- 091 · Per-milestone payments (2026-08, Karan smoke-test rework)
--
-- A payment can now be recorded against a specific MILESTONE (the "✓ Record
-- payment" button on each milestone), capturing method / reference / date /
-- notes. The payment still rolls up to the invoice — the existing trigger
-- (recompute_invoice_paid_cents) recomputes invoice.paid_cents from ALL of its
-- payments regardless of milestone_id — so nothing double-counts and the
-- invoice-level KPIs are unchanged. A milestone's own "paid" is derived as the
-- SUM of payments carrying its milestone_id.
--
-- ON DELETE SET NULL: deleting a milestone does NOT delete its payment history —
-- the payment simply becomes an invoice-level (untagged) payment, so money is
-- never lost from the invoice total.
--
-- Idempotent — safe to re-paste.

ALTER TABLE public.commercial_invoice_payments
  ADD COLUMN IF NOT EXISTS milestone_id UUID
    REFERENCES public.commercial_invoice_milestones(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cip_milestone
  ON public.commercial_invoice_payments(milestone_id)
  WHERE milestone_id IS NOT NULL;

COMMENT ON COLUMN public.commercial_invoice_payments.milestone_id IS
  '2026-08 — optional milestone this payment is credited to. NULL = invoice-level payment. Invoice paid_cents = SUM of all payments (trigger); milestone paid = SUM of payments with this milestone_id.';
