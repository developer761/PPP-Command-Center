-- Migration 025: Phase 1 Batch 5c — account tags.
--
-- Free-form multi-select labels on commercial accounts (Hospitality,
-- Healthcare, Retail, Property Mgmt, etc.). Separate from `industry`
-- (which is a single canonical string) — tags are loose, multi-value,
-- and emerge naturally as PPP staff add them. No separate catalog
-- table; the tag picker UI shows what's been used elsewhere.
--
-- Tag uniqueness is case-insensitive per account (so "Hospitality" and
-- "hospitality" don't both attach). Enforced via partial unique index
-- on lower(tag) — Postgres allows UNIQUE INDEX on expressions where
-- UNIQUE CONSTRAINT can't.
--
-- Hard delete on detach (no soft delete): if a tag is removed, the
-- junction row goes. Audit log captures the delete via the helpers in
-- lib/commercial/accounts/tags.ts.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.commercial_account_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE CASCADE,
  -- Bound tag length: 1-50 chars. Anything longer is almost certainly
  -- a sentence or accidental paste — the picker should keep this in
  -- check at the UI layer too.
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Case-insensitive uniqueness per account.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_account_tags_account_tag_lower_idx
  ON public.commercial_account_tags (account_id, lower(tag));

-- Fast lookups for the "show me all accounts with tag X" filter.
CREATE INDEX IF NOT EXISTS commercial_account_tags_tag_lower_idx
  ON public.commercial_account_tags (lower(tag));

-- Per-account list lookup (for the Info tab + row snippet).
CREATE INDEX IF NOT EXISTS commercial_account_tags_account_idx
  ON public.commercial_account_tags (account_id);
