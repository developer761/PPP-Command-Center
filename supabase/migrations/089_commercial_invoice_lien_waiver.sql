-- 089 · Lien waiver per invoice/milestone (2026-08)
-- Katie/Karan: every invoice IS a milestone, and every milestone needs a lien
-- waiver. We don't GENERATE liens — they arrive on paper / by email and we
-- STORE them. The waiver file is a per-deal document (parent_type=opportunity,
-- category=lien_waiver) so it shows in the deal's Documents tab automatically;
-- this column links the specific waiver to its invoice so the invoice/milestone
-- shows a ✓/missing status. Idempotent.

ALTER TABLE commercial_invoices
  ADD COLUMN IF NOT EXISTS lien_waiver_document_id uuid;
