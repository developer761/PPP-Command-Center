-- Per-change-order document attachments (signed CO PDFs / backup).
-- Mirrors commercial_invoice_attachments. Paste-safe: one short statement per
-- line, all idempotent; the app sets timestamps (no DB defaults except id).
CREATE TABLE IF NOT EXISTS commercial_change_order_attachments (id uuid PRIMARY KEY);
ALTER TABLE commercial_change_order_attachments ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE commercial_change_order_attachments ADD COLUMN IF NOT EXISTS change_order_id uuid;
ALTER TABLE commercial_change_order_attachments ADD COLUMN IF NOT EXISTS document_id uuid;
ALTER TABLE commercial_change_order_attachments ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
ALTER TABLE commercial_change_order_attachments ADD COLUMN IF NOT EXISTS created_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_cca_change_order ON commercial_change_order_attachments (change_order_id);
CREATE INDEX IF NOT EXISTS idx_cca_document ON commercial_change_order_attachments (document_id);
