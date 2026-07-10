-- 047_commercial_documents_polymorphic.sql
--
-- Phase C · Documents (polymorphic).
--
-- Adds a general-purpose document store scoped by (parent_type, parent_id)
-- so the same table serves per-Opportunity docs today AND per-Project
-- docs when Phase H ships. Separate from:
--   - commercial_account_documents (compliance: COI/W9/master agreements)
--   - commercial_opportunity_attachments (structured Plans & Specs)
-- Those two stay as-is — Phase C is a strict addition, not a migration.
--
-- Feature set:
--   * Version chain via parent_document_id (points at prior version)
--   * Status DAG: draft → pending_review → (approved | rejected);
--     rejected → draft; superseded is terminal (set only by the
--     version-bump path)
--   * Favorite flag with a 5-per-(parent, category) cap (enforced at the
--     app layer — trigger overkill for a soft rule)
--   * Soft-delete via deleted_at (audit trail preserved)
--
-- Idempotent throughout. Rerun-safe.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════
-- 1. Table
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.commercial_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Polymorphic parent. In Phase C only 'opportunity' has a live surface;
  -- 'project' is reserved for Phase H — same schema, zero DB change then.
  parent_type TEXT NOT NULL CHECK (parent_type IN ('opportunity', 'project')),
  parent_id UUID NOT NULL,

  -- Category — free-form label with 'other' as fallback so users can't
  -- get stuck at upload time. See lib/commercial/documents/categories.ts
  -- for the current list.
  category TEXT NOT NULL DEFAULT 'other',

  -- Human label. Not the storage_key.
  file_name TEXT NOT NULL,
  notes TEXT,

  -- Physical file
  storage_key TEXT NOT NULL,          -- path inside the bucket
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL,

  -- Version chain. First version = NULL. Later versions point at the
  -- immediately-previous row (a linked list, not a tree — one active
  -- version per chain at a time).
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  parent_document_id UUID REFERENCES public.commercial_documents(id) ON DELETE SET NULL,

  -- Status DAG. Enforced app-side (lib/commercial/documents/status.ts).
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'approved', 'rejected', 'superseded')),

  -- Favorites — nullable timestamptz. 5-per-(parent, category) cap
  -- enforced at the app layer, not via trigger (spec calls this a soft
  -- limit + we want a friendly "unfavorite one first" prompt rather
  -- than a hard DB reject).
  favorited_at TIMESTAMPTZ,

  -- Audit
  uploaded_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Soft delete
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Housekeeping
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════
-- 2. Indexes
-- ═══════════════════════════════════════════════════════════════════

-- Hot-path list query: docs for an opp/project, newest first, live only.
CREATE INDEX IF NOT EXISTS idx_commercial_documents_parent_live
  ON public.commercial_documents (parent_type, parent_id, uploaded_at DESC)
  WHERE deleted_at IS NULL;

-- Version-chain lookup (find the head of a chain + walk back for history).
CREATE INDEX IF NOT EXISTS idx_commercial_documents_parent_chain
  ON public.commercial_documents (parent_document_id)
  WHERE parent_document_id IS NOT NULL;

-- Favorites-panel query.
CREATE INDEX IF NOT EXISTS idx_commercial_documents_favorites
  ON public.commercial_documents (parent_type, parent_id, category, favorited_at DESC)
  WHERE favorited_at IS NOT NULL AND deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 3. updated_at trigger — mirrors the pattern from earlier migrations
--    so any UPDATE bumps updated_at automatically.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.commercial_documents_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_commercial_documents_touch ON public.commercial_documents;
CREATE TRIGGER trg_commercial_documents_touch
  BEFORE UPDATE ON public.commercial_documents
  FOR EACH ROW EXECUTE FUNCTION public.commercial_documents_touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════
-- 4. Diagnostic
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM public.commercial_documents;
  RAISE NOTICE 'commercial_documents ready — % existing rows', n;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- 5. Manual Supabase-UI step (do this in the Storage console — cannot
--    be expressed in SQL alone):
--
--    - Create bucket: `commercial-documents`
--    - Public: OFF (signed URLs only, service-role reads)
--    - File size limit: 100 MB (bid sets can be big)
--    - Allowed MIME types (optional whitelist — app also sniffs magic
--      bytes on the POST route):
--        application/pdf
--        image/jpeg image/png image/heic image/webp
--        application/msword
--        application/vnd.openxmlformats-officedocument.wordprocessingml.document
--        application/vnd.ms-excel
--        application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
--        text/plain
--
--    Storage path convention (set by the app on upload):
--        {parent_type}s/{parent_id}/{document_id}-{sanitized_file_name}
-- ═══════════════════════════════════════════════════════════════════
