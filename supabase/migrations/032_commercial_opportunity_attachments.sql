-- Migration 032: Phase 2 Batch 4 — Plans & Specs attachments per Opportunity.
--
-- Mirrors commercial_account_documents (migrations 020+022+023) but
-- WITHOUT the category enum. Opp attachments are arbitrary files
-- (RFP.pdf, plans_set_A.pdf, spec_book.pdf, proposal_v2.pdf) — Alex
-- names them whatever he wants. The list page sorts by uploaded_at
-- descending; archived flag keeps the timeline clean.
--
-- Storage bucket: `commercial-opportunity-files` (private, signed-URL
-- downloads only). Path pattern: {account_id}/{opp_id}/{document_id}-{file_name}.
-- Karan creates the bucket in the Supabase UI before this migration's
-- code surfaces light up.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.commercial_opportunity_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,

  -- Display name (user-supplied or cleaned-up from the uploaded filename).
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),

  -- Immutable reference to the Storage object. UNIQUE so the same
  -- Storage path can't be referenced by two metadata rows (orphans
  -- can still exist if a row insert fails after the file upload;
  -- the lib cleans up on failure).
  storage_key TEXT NOT NULL UNIQUE,

  size_bytes INTEGER,
  mime_type TEXT,

  -- Version tracker. If a user re-uploads the same logical file (same
  -- file_name) we increment version + auto-archive the prior row.
  -- For arbitrary files where the name differs each time, version=1
  -- on every row.
  version INTEGER NOT NULL DEFAULT 1,

  -- Optional free-form context — "Final proposal v3 from customer" etc.
  notes TEXT,

  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Archive flag. Re-upload of the same file_name auto-archives the
  -- prior active row. Manual archive available too.
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  archived_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Hot path: "show me current files for this opp" — Plans & Specs tab.
CREATE INDEX IF NOT EXISTS commercial_opportunity_attachments_opp_active_idx
  ON public.commercial_opportunity_attachments (opportunity_id, uploaded_at DESC)
  WHERE archived = FALSE;

-- "What's the version history of this filename" — for the auto-version
-- + archive-prior logic on re-upload.
CREATE INDEX IF NOT EXISTS commercial_opportunity_attachments_filename_idx
  ON public.commercial_opportunity_attachments (opportunity_id, lower(file_name));

-- "All files this user uploaded" (future).
CREATE INDEX IF NOT EXISTS commercial_opportunity_attachments_uploader_idx
  ON public.commercial_opportunity_attachments (uploaded_by_user_id)
  WHERE archived = FALSE;
