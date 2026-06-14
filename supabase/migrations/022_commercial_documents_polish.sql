-- Migration 022: Phase 1 Batch 3 — small additions to commercial_account_documents
-- for the Documents tab build.
--
-- The 020 migration covered the basics. This adds:
--   - mime_type (so the UI can render a PDF-vs-image-vs-doc icon without sniffing)
--   - archived_at + archived_by_user_id (audit trail for "who archived this version")
--
-- Safe to re-run.

ALTER TABLE public.commercial_account_documents
  ADD COLUMN IF NOT EXISTS mime_type TEXT;

ALTER TABLE public.commercial_account_documents
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE public.commercial_account_documents
  ADD COLUMN IF NOT EXISTS archived_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill archived_at for rows where `archived = TRUE` so the audit log doesn't
-- show NULL forever. Best-effort: stamps NOW() since we don't have the real time.
UPDATE public.commercial_account_documents
   SET archived_at = NOW()
 WHERE archived = TRUE AND archived_at IS NULL;
