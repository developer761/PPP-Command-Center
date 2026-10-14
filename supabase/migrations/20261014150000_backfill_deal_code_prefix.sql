-- Give every account its own deal-number prefix. Again.
--
-- Brendan, via migration 171: "every opp has a custom identifier as Job GC-0001
-- but all the opps are the same."
--
-- Migration 169 wrote this backfill and declared the column "Never null". It is
-- null on 80 of 85 accounts in production, so it never ran there. The five that
-- do have a prefix got it from `createCommercialAccount`, which derives one on
-- insert — those are the accounts created after that code shipped. So the bug
-- Brendan reported is still live for every account that predates it, and every
-- NEW deal on those 80 accounts is still being stamped with the shared "GC"
-- fallback from `formatDealNumberForAccount`.
--
-- Re-stated here rather than editing 169, because 169 may have run in some other
-- environment and a migration that has run should not change underneath it.
--
-- WHAT THIS DOES NOT DO: renumber anything. `deal_number` is stamped onto the
-- opportunity at creation and stored as text; this column is only read when a
-- new deal is numbered. A proposal also snapshots its number into header_json,
-- so renumbering would leave the app showing DEV-0001 while a PDF already in a
-- GC's inbox says GC-0001 — 169's own reasoning, and it still holds. The eight
-- live deals currently showing a "GC-" number keep it.
--
-- `deal_number` being per-CUSTOMER is deliberate and is NOT what this fixes:
-- GC-0001 means "the first job for this GC", and two builders both having a job
-- #1 is the point. `project_number` is the globally unique identifier and is
-- intact — 151 of 151 populated, 151 distinct, verified 2026-10-14.
--
-- Collisions are expected and allowed: four accounts beginning "The", and
-- "Construction By Design" / "Construction Management & Builders" both reducing
-- to CON. The column comment already calls the prefix "editable to resolve
-- collisions", so a human fixes the ones that matter. Several apparent
-- collisions are in fact the same GC entered twice (Vision, Spano, Cummins,
-- Doherty) and want merging rather than renaming.

UPDATE public.commercial_accounts
   SET deal_code_prefix = UPPER(
     SUBSTRING(regexp_replace(COALESCE(company_name, ''), '[^A-Za-z]', '', 'g'), 1, 3)
   )
 WHERE (deal_code_prefix IS NULL OR trim(deal_code_prefix) = '')
   AND regexp_replace(COALESCE(company_name, ''), '[^A-Za-z]', '', 'g') <> '';

-- An account whose name carries no letters at all ("123 Holdings") still needs
-- something stable rather than the shared "GC". Zero rows need this today; it is
-- here so the column's "never null" promise is actually true afterwards.
UPDATE public.commercial_accounts
   SET deal_code_prefix = 'ACC'
 WHERE deal_code_prefix IS NULL OR trim(deal_code_prefix) = '';
