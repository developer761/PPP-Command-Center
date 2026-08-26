-- 169 · Every account gets a deal prefix, not just the ones that existed in July.
--
-- Brendan 2026-08-26: "Every opp has a custom identifier as Job GC-0001 but the
-- issue is all the opps are the same."
--
-- He is right, and it is not the sequence — that works. `deal_number` is
-- `{prefix}-{seq}` where the sequence is PER ACCOUNT (Karan Test 1 correctly has
-- GC-0001 and GC-0002). The prefix is what broke.
--
-- Migration 065 added `deal_code_prefix` and BACKFILLED the accounts that
-- existed that day, which is why the older ones read KAR-, BOB-, TES-. It added
-- no trigger, and `createCommercialAccount` never set the column — so every
-- account created since carries NULL, and the generator falls back to the
-- literal "GC". Ten accounts, ten NULLs, and every new deal in the system
-- reading GC-0001.
--
-- Two halves: backfill the NULLs here, and derive it on insert from now on. The
-- insert side is done in the application rather than a trigger, so the prefix a
-- person sees in the create form is the prefix they get.
--
-- EXISTING deal_numbers are deliberately LEFT ALONE. A proposal snapshots its
-- number into header_json when it is created, so renumbering a deal now would
-- leave the app showing DEV-0001 while a PDF already in a GC's inbox says
-- GC-0001. A duplicate-looking number on old test data is a smaller problem
-- than a document that disagrees with the system. New deals will be correct.

UPDATE public.commercial_accounts
   SET deal_code_prefix = UPPER(
     SUBSTRING(regexp_replace(COALESCE(company_name, ''), '[^A-Za-z]', '', 'g'), 1, 3)
   )
 WHERE deal_code_prefix IS NULL
   AND regexp_replace(COALESCE(company_name, ''), '[^A-Za-z]', '', 'g') <> '';

-- An account whose name carries no letters at all ("123 Holdings") still needs
-- something stable rather than the shared "GC".
UPDATE public.commercial_accounts
   SET deal_code_prefix = 'ACC'
 WHERE deal_code_prefix IS NULL OR trim(deal_code_prefix) = '';

COMMENT ON COLUMN public.commercial_accounts.deal_code_prefix IS
  'Three-letter code opening this account''s deal numbers ("DEV-0001"). Derived from company_name on insert and editable to resolve collisions (two "AL..." GCs). Never null: accounts with no letters in the name get ACC.';
