-- 096 · Invoice attachments (Phase 2)
--
-- Links arbitrary commercial_documents (parent_type=opportunity, category=
-- invoice_attachment) to a specific invoice. Short single-statement CREATE so a
-- wrap-happy paste tool can't split a line. App enforces the relationships.

CREATE TABLE IF NOT EXISTS public.commercial_invoice_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid,
  document_id uuid,
  created_by_user_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cia_inv_doc ON public.commercial_invoice_attachments (invoice_id, document_id);
CREATE INDEX IF NOT EXISTS idx_cia_inv ON public.commercial_invoice_attachments (invoice_id);
