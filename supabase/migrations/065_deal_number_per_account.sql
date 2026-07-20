-- ────────────────────────────────────────────────────────────────────
-- Migration 065 — Per-account sequential deal number ("ALT-0125")
-- ────────────────────────────────────────────────────────────────────
-- Karan 2026-07-20 (Phase G Q1): match Tomco's letterhead convention
-- from the JD Sports reference PDF ("No. ALT0125"). Each account gets
-- its own sequence, prefixed by a 3-letter code derived from the GC
-- company name. Editable in account settings so admins can resolve
-- prefix collisions ("Alta Construction" and "Alpine Roofing" both
-- would derive ALT — override on one).
--
-- Format: `{deal_code_prefix}-{4-digit zero-padded seq}` → "ALT-0125"
--
-- Idempotent — ADD COLUMN IF NOT EXISTS + WHERE guards on backfill.
-- Safe to re-run.

-- 1. Prefix column on accounts (auto-derive on backfill + new inserts).
ALTER TABLE public.commercial_accounts
  ADD COLUMN IF NOT EXISTS deal_code_prefix TEXT;

-- Backfill: derive 3-char uppercase alpha from company_name.
UPDATE public.commercial_accounts
   SET deal_code_prefix = UPPER(
     SUBSTRING(
       regexp_replace(COALESCE(company_name, ''), '[^A-Za-z]', '', 'g'),
       1, 3
     )
   )
 WHERE deal_code_prefix IS NULL;

-- Fallback for accounts with no alpha chars in the name.
UPDATE public.commercial_accounts
   SET deal_code_prefix = 'GC'
 WHERE deal_code_prefix IS NULL
    OR deal_code_prefix = '';

-- 2. Per-account counter table. next_seq is what the NEXT insert gets.
CREATE TABLE IF NOT EXISTS public.commercial_account_deal_counter (
  account_id UUID PRIMARY KEY
    REFERENCES public.commercial_accounts(id) ON DELETE CASCADE,
  next_seq INT NOT NULL DEFAULT 1
    CHECK (next_seq > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. deal_number column on opps + index.
ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS deal_number TEXT;

CREATE INDEX IF NOT EXISTS commercial_opportunities_deal_number_idx
  ON public.commercial_opportunities (deal_number)
  WHERE deal_number IS NOT NULL;

-- 4. Backfill existing opps in created_at order per account.
--
-- Includes soft-deleted rows so numbers are stable — deleting a deal
-- shouldn't shift numbers of siblings. Counter is seeded to the next
-- available seq after backfill so new inserts continue the sequence.
DO $$
DECLARE
  acc RECORD;
  opp RECORD;
  seq INT;
  prefix TEXT;
BEGIN
  FOR acc IN
    SELECT id, deal_code_prefix FROM public.commercial_accounts
  LOOP
    seq := 1;
    prefix := COALESCE(NULLIF(acc.deal_code_prefix, ''), 'GC');
    FOR opp IN
      SELECT id
        FROM public.commercial_opportunities
       WHERE account_id = acc.id
         AND deal_number IS NULL
       ORDER BY created_at ASC
    LOOP
      UPDATE public.commercial_opportunities
         SET deal_number = prefix || '-' || LPAD(seq::TEXT, 4, '0')
       WHERE id = opp.id;
      seq := seq + 1;
    END LOOP;
    -- Seed / update the counter to the next available seq.
    INSERT INTO public.commercial_account_deal_counter (account_id, next_seq)
    VALUES (acc.id, seq)
    ON CONFLICT (account_id) DO UPDATE
      SET next_seq = GREATEST(
            public.commercial_account_deal_counter.next_seq,
            EXCLUDED.next_seq
          ),
          updated_at = NOW();
  END LOOP;
END $$;
