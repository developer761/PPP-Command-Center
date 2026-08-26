-- 171 — Re-stamp existing job numbers with their customer's prefix.
--
-- Brendan: "every opp has a custom identifier as Job GC-0001 but all the opps
-- are the same."
--
-- Two different things are tangled here, and only one of them is a bug.
--
-- NOT a bug: `deal_number` is deliberately per-CUSTOMER, not global. GC-0001
-- means "the first job we've done for this GC" — the second job for the same
-- builder is -0002. Two different builders both having a job #1 is the point.
-- The globally unique identifier is `project_number`, which renders right
-- beside it as OPP-2026-0029.
--
-- The bug: the PREFIX. It is supposed to be the customer's initials, so
-- Brendans Test Co reads BRE-0001 and McDonalds Builders reads MCD-0001 —
-- which is what makes the number legible at a glance. `deal_code_prefix` was
-- only added to accounts recently; migration 169 backfilled it onto the
-- ACCOUNTS but never went back to the opportunities already stamped. So every
-- job created before that still carries the literal fallback "GC", and that is
-- what Brendan is seeing everywhere — including on the internal report.
--
-- Only rows still on the fallback are touched. A job already carrying its
-- customer's prefix keeps the number it has: these appear on documents that
-- have gone out, and renumbering one would be worse than an ugly prefix.
UPDATE commercial_opportunities o
   SET deal_number = a.deal_code_prefix || substring(o.deal_number from 3)
  FROM commercial_accounts a
 WHERE o.account_id = a.id
   AND o.deal_number ~ '^GC-[0-9]+$'
   AND a.deal_code_prefix IS NOT NULL
   AND btrim(a.deal_code_prefix) <> ''
   AND a.deal_code_prefix <> 'GC';
