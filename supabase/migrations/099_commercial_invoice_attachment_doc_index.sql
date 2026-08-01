-- Audit follow-up: index invoice-attachment lookups by document_id (096 only
-- indexed invoice_id). Symmetry with 098's CO-attachment indexes. Paste-safe.
CREATE INDEX IF NOT EXISTS idx_invoice_attachments_document ON commercial_invoice_attachments (document_id);
