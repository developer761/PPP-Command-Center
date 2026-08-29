-- 173 — Finish the cleanup that migration-era fix 2026-08-10 started.
--
-- Deleting a GC has cascaded to its deals since 2026-08-10. Before that it
-- didn't, so eleven opportunities are still marked live under an account that
-- was deleted months ago — along with 38 proposals and one work order hanging
-- off them.
--
-- Nothing user-facing renders them: every list filters on the account, the
-- pages show the not-found card, and the APIs 404. So this is not a visible
-- bug. It is worse in a quieter way — it is a permanent source of false
-- alarms. It has already cost real time this week: a smoke test that picked
-- one of these and passed 73/73 while exercising a not-found page, and an
-- afternoon spent chasing "why does this deal have no account".
--
-- Safe because the fix that stops NEW ones is already in place; this only
-- squares the books behind it. Deliberately mirrors what
-- softDeleteCommercialOpportunity does today, and nothing more:
--
--   · Stamps deleted_at with the ACCOUNT's deletion time, not now(), so the
--     history reads honestly — these became unreachable the day the GC went,
--     not the day someone noticed.
--   · Only touches rows whose account is deleted AND which carry no payment.
--     The live cascade refuses to delete anything with money recorded against
--     it; a backfill must not be laxer than the code it is catching up to.
--   · Proposals follow their opportunity, matching the code path.
--   · Work orders are VOIDED, which is their soft-delete.

-- 1. The opportunities themselves.
UPDATE commercial_opportunities o
   SET deleted_at = a.deleted_at,
       updated_at = now()
  FROM commercial_accounts a
 WHERE o.account_id = a.id
   AND a.deleted_at IS NOT NULL
   AND o.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM commercial_invoices i
      WHERE i.opportunity_id = o.id
        AND i.deleted_at IS NULL
        AND COALESCE(i.paid_cents, 0) > 0
   );

-- 2. Their proposals.
UPDATE commercial_proposals p
   SET deleted_at = o.deleted_at,
       updated_at = now()
  FROM commercial_opportunities o
 WHERE p.opportunity_id = o.id
   AND o.deleted_at IS NOT NULL
   AND p.deleted_at IS NULL;

-- 3. Their invoices (none carry a payment today; the guard above kept any
--    that did, and this leaves those alone too).
UPDATE commercial_invoices i
   SET deleted_at = o.deleted_at
  FROM commercial_opportunities o
 WHERE i.opportunity_id = o.id
   AND o.deleted_at IS NOT NULL
   AND i.deleted_at IS NULL
   AND COALESCE(i.paid_cents, 0) = 0;

-- 4. Their work orders — voided_at is the soft-delete on this table.
UPDATE commercial_work_orders w
   SET voided_at = o.deleted_at
  FROM commercial_opportunities o
 WHERE w.opportunity_id = o.id
   AND o.deleted_at IS NOT NULL
   AND w.voided_at IS NULL;

-- 5. Their project purchases.
UPDATE commercial_project_purchases pp
   SET deleted_at = o.deleted_at
  FROM commercial_opportunities o
 WHERE pp.opportunity_id = o.id
   AND o.deleted_at IS NOT NULL
   AND pp.deleted_at IS NULL;
