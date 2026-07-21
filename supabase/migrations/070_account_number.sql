-- ────────────────────────────────────────────────────────────────────
-- Migration 070 — Account #### unique identifier (ACC-####)
-- ────────────────────────────────────────────────────────────────────
-- Karan 2026-07-21: "Unique Identifier - Each Account, Opportunity,
-- Proposal, etc." Opportunity (ALT-####), Proposal (PROP-####), and
-- Invoice (INV-####) already have human-readable IDs; Account had only a
-- 3-letter deal-code prefix. This adds a first-class global sequential
-- account number rendered as ACC-#### in the UI.
--
-- Mirrors the proposal_seq pattern from migration 069 exactly: global
-- sequence + backfill in created_at order + BEFORE INSERT trigger +
-- partial unique index. Idempotent throughout — safe to re-run.

CREATE SEQUENCE IF NOT EXISTS public.commercial_account_seq START 1;

ALTER TABLE public.commercial_accounts
  ADD COLUMN IF NOT EXISTS account_seq INTEGER;

-- Backfill existing accounts in created_at order so early customers get
-- low numbers. Guarded so re-runs skip already-numbered rows. Soft-deleted
-- rows are numbered too so the sequence stays stable + gap-free.
DO $$
DECLARE
  r RECORD;
  n INTEGER;
BEGIN
  FOR r IN
    SELECT id FROM public.commercial_accounts
    WHERE account_seq IS NULL
    ORDER BY created_at ASC, id ASC
  LOOP
    n := nextval('public.commercial_account_seq');
    UPDATE public.commercial_accounts SET account_seq = n WHERE id = r.id;
  END LOOP;
END $$;

-- Trigger — auto-assign account_seq on insert.
CREATE OR REPLACE FUNCTION public.commercial_account_assign_seq()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.account_seq IS NULL THEN
    NEW.account_seq := nextval('public.commercial_account_seq');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commercial_account_assign_seq_trg ON public.commercial_accounts;
CREATE TRIGGER commercial_account_assign_seq_trg
  BEFORE INSERT ON public.commercial_accounts
  FOR EACH ROW EXECUTE FUNCTION public.commercial_account_assign_seq();

-- Unique index so a data-repair mistake can't create dupes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'commercial_accounts_seq_unique_idx'
  ) THEN
    CREATE UNIQUE INDEX commercial_accounts_seq_unique_idx
      ON public.commercial_accounts (account_seq)
      WHERE account_seq IS NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.commercial_accounts.account_seq IS
  'Global sequential ID. Rendered as ACC-#### (LPAD 4) in the UI.
   Auto-assigned via trigger on insert; nullable at the column level
   only so backfill can catch up. New rows always get one.';
