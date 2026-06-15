-- Migration 026: Phase 1 Batch A — contact polish.
--
-- Extends `commercial_account_contacts` (the per-account contact-role
-- junction from migration 020) with:
--
--   1. `is_primary` — at-most-one starred contact per account. Drives
--      the "primary contact" pill on the detail header + the quick
--      email button next to it. Enforced via partial UNIQUE INDEX.
--
--   2. `last_contacted_at` / `last_contacted_by_user_id` — when the
--      account was last touched by anyone on the PPP side. Powers the
--      "haven't heard in 60d" sort + the per-contact timestamp display.
--      Manual today (a button in the UI marks "I just emailed Jane");
--      will flip auto when the email-send phase lands.
--
-- Safe to re-run.

ALTER TABLE public.commercial_account_contacts
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.commercial_account_contacts
  ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;

ALTER TABLE public.commercial_account_contacts
  ADD COLUMN IF NOT EXISTS last_contacted_by_user_id UUID
  REFERENCES auth.users(id) ON DELETE SET NULL;

-- One primary per account, regardless of role. Partial unique index
-- lets us enforce this without forbidding multiple non-primary rows
-- (which a regular UNIQUE constraint would do).
CREATE UNIQUE INDEX IF NOT EXISTS commercial_account_contacts_primary_idx
  ON public.commercial_account_contacts (account_id)
  WHERE is_primary = TRUE;
