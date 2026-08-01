-- 096 · Invoice attachments (Phase 2)
--
-- Links commercial_documents (parent=opportunity, category=invoice_attachment)
-- to a specific invoice. One short idempotent statement per line so a paste tool
-- that drops/wraps lines can't corrupt it - re-run to converge. App sets
-- created_at + enforces the relationships.

CREATE TABLE IF NOT EXISTS public.commercial_invoice_attachments (id uuid PRIMARY KEY);
ALTER TABLE public.commercial_invoice_attachments ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.commercial_invoice_attachments ADD COLUMN IF NOT EXISTS invoice_id uuid;
ALTER TABLE public.commercial_invoice_attachments ADD COLUMN IF NOT EXISTS document_id uuid;
ALTER TABLE public.commercial_invoice_attachments ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
ALTER TABLE public.commercial_invoice_attachments ADD COLUMN IF NOT EXISTS created_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_cia_inv ON public.commercial_invoice_attachments (invoice_id);
