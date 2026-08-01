-- 094 · Per-payment lien waiver (Phase 2)
--
-- A PARTIAL lien waiver arrives per PAYMENT: the GC sends it → we store the
-- signed file against that specific payment. Mirrors the invoice-level (089) and
-- milestone-level (090) waiver columns: a plain uuid pointer to a
-- commercial_documents row (parent_type=opportunity, category=lien_waiver),
-- app-enforced (soft-delete → treat as null), no FK — consistent with the
-- sibling waiver columns. The invoice-level waiver (089) is the FINAL waiver.
--
-- Idempotent — safe to re-paste.

ALTER TABLE public.commercial_invoice_payments
  ADD COLUMN IF NOT EXISTS lien_waiver_document_id UUID;

COMMENT ON COLUMN public.commercial_invoice_payments.lien_waiver_document_id IS
  'Phase 2 — stored PARTIAL lien waiver for this payment (commercial_documents id, category lien_waiver). Null until the signed waiver is uploaded. The invoice-level lien_waiver_document_id (089) is the FINAL waiver.';
