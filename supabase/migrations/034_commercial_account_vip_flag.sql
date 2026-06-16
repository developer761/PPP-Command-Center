-- Migration 034: Phase 1 Batch 7 polish — Key Relationship / VIP flag.
--
-- The A/B/C rating column (migration 020) captures qualitative customer
-- value but doesn't distinguish "strategic partnership we'd never lose"
-- from a generic A. Alex flags certain accounts as Key Relationships:
-- biggest GCs, recurring multi-year customers, properties owned by
-- decision-makers PPP has personal trust with. These deserve a visible
-- ★ badge across every surface that lists the account.
--
-- One simple boolean on commercial_accounts. Default FALSE. Indexed so
-- the list page can filter to "Key Relationships only" without a full
-- scan once the book grows.
--
-- Safe to re-run.

ALTER TABLE public.commercial_accounts
  ADD COLUMN IF NOT EXISTS is_key_relationship BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS commercial_accounts_key_relationship_idx
  ON public.commercial_accounts (is_key_relationship)
  WHERE is_key_relationship = TRUE AND deleted_at IS NULL;
