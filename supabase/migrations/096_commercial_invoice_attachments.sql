-- 096 · Invoice attachments (Phase 2)
--
-- Arbitrary files attached to a specific invoice (e.g. sent alongside the bill —
-- a signed contract copy, a photo, a spec sheet). The file itself is a
-- commercial_documents row (parent_type=opportunity, category=invoice_attachment)
-- so it ALSO appears in the deal's Documents tab; this link table scopes it to
-- the one invoice for the invoice-detail listing. (commercial_documents has no
-- 'invoice' parent_type — it's opportunity/project only — hence the link table.)
--
-- Idempotent — safe to re-paste.

CREATE TABLE IF NOT EXISTS public.commercial_invoice_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL
    REFERENCES public.commercial_invoices(id) ON DELETE CASCADE,
  document_id UUID NOT NULL
    REFERENCES public.commercial_documents(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.commercial_invoice_attachments IS
  'Phase 2 — links arbitrary commercial_documents to a specific invoice. The doc still parents to the opportunity so it shows in the deal Documents too; this row scopes it to the invoice.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_cia_invoice_document
  ON public.commercial_invoice_attachments(invoice_id, document_id);

CREATE INDEX IF NOT EXISTS idx_cia_invoice
  ON public.commercial_invoice_attachments(invoice_id);
