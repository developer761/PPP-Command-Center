-- A job can release retainage more than once. (Stephanie, 2026-10-16)
--
-- HER NOTE, on the LMJ Cipla expansion:
--
--   "We billed the contract in full and then billed for retainage and then
--    received payment on the job in full. After we received that payment, a
--    change order came across and we had to bill for that plus retainage. This
--    happened 2x, meaning there was a total of 3 retainage AIA's... this is
--    kind of something that happens often and we have to be able to record in
--    real time."
--
-- Migration 162 added `is_retainage_release` with a unique index allowing ONE
-- per job, and gave this reason:
--
--   "A second would bill retainage that is already released: line 7 would carry
--    the first release forward, so line 8 would come out at zero — a
--    certificate for nothing, sent to a GC."
--
-- That was TRUE OF THE MATH AS IT THEN STOOD, and it is not true any more.
-- Under the old rule retainage was recomputed on ALL completed work every
-- period, so after a release the next application re-withheld 5% of the whole
-- contract and the ladder went backwards — Cipla's Application 6 was showing
-- CURRENT PAYMENT DUE as MINUS $3,431.36. Retainage is now withheld once (see
-- lineRetainableCents), so the sequence Stephanie describes computes correctly:
--
--   App 5  release        line 5 $0      line 8 $4,381.36   (the held retainage)
--   App 6  $1,000 CO      line 5 $50.00  line 8 $950.00     (5% of the CO only)
--   App 7  release        line 5 $0      line 8 $50.00      (the CO's retainage)
--
-- Line 8 is zero only when nothing is held — and THAT is the real rule the
-- index was reaching for. It is enforced in `createAiaApplication`, which
-- refuses a release with no retainage to release and can say so in words,
-- where a unique-index violation could only fail.
--
-- Dropped by LOOKUP, not by name: the name in 162 is what this codebase
-- intended, but an index dropped by a name Postgres never assigned is dropped
-- silently and the constraint stays live. Find it by its table, its columns and
-- its partial predicate, and drop whatever it is actually called.
DO $$
DECLARE
  names text[];
  idx   text;
  cons  text;
BEGIN
  -- Collected FIRST, then dropped: iterating a catalogue cursor while the loop
  -- body drops rows out from under it is how one of two matches gets skipped.
  SELECT coalesce(array_agg(ic.relname), '{}'::text[])
    INTO names
  FROM pg_index i
  JOIN pg_class  ic ON ic.oid = i.indexrelid
  JOIN pg_class  tc ON tc.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = tc.relnamespace
  WHERE n.nspname = 'public'
    AND tc.relname = 'commercial_aia_applications'
    AND i.indisunique
    AND i.indpred IS NOT NULL
    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%is_retainage_release%'
    -- NOT the one-DRAFT-release index created at the foot of this file. Re-running
    -- this migration must be a no-op, and without this the second run drops the
    -- concurrency backstop the first run installed.
    AND pg_get_expr(i.indpred, i.indrelid) NOT ILIKE '%status%'
    AND ic.relname <> 'commercial_aia_one_draft_release_per_opp';

  IF array_length(names, 1) IS NULL THEN
    RAISE NOTICE 'no one-release-per-job index found — nothing to drop';
  END IF;

  FOREACH idx IN ARRAY names
  LOOP
    -- An index that BACKS a constraint cannot be dropped directly ("cannot
    -- drop index ... because constraint ... requires it"), so drop the
    -- constraint where there is one and the index goes with it. This one was
    -- created with CREATE UNIQUE INDEX and has no constraint, but a migration
    -- that only works against the history it expects is a migration that fails
    -- on the one database that drifted.
    -- Reset first: SELECT INTO leaves the variable UNCHANGED when no row
    -- matches, so a second pass would reuse the first pass's constraint name.
    cons := NULL;
    SELECT con.conname INTO cons
    FROM pg_constraint con
    JOIN pg_class ic2 ON ic2.oid = con.conindid
    WHERE ic2.relname = idx;

    IF cons IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.commercial_aia_applications DROP CONSTRAINT %I', cons);
      RAISE NOTICE 'dropped one-release-per-job constraint: % (index %)', cons, idx;
    ELSE
      EXECUTE format('DROP INDEX IF EXISTS public.%I', idx);
      RAISE NOTICE 'dropped one-release-per-job index: %', idx;
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN commercial_aia_applications.is_retainage_release IS
  'This application releases held retainage (Application for Final Payment): retainage_pct is 0 and line 8 equals the retainage held. A job may have several — a change order approved after a release is billed, retained and released again (Stephanie 2026-10-16).';

-- Non-unique, because the lookup that replaced the constraint — "the latest
-- issued release below this application's number", run per deal on every
-- certificate and every portfolio report — is the hot path now.
CREATE INDEX IF NOT EXISTS commercial_aia_release_by_opp_number
  ON commercial_aia_applications (opportunity_id, application_number)
  WHERE is_retainage_release AND deleted_at IS NULL;

/*
 * ONE DRAFT RELEASE AT A TIME — the backstop the dropped index was also doing.
 *
 * "Bill the retainage" takes no inputs, so it is a single button, and the old
 * unique index was what stopped a double-click or two people in two tabs from
 * raising two release certificates for the same money. `createAiaApplication`
 * now checks that there IS retainage held, but it reads and then inserts, and
 * two requests can both read `held > 0` before either writes.
 *
 * A job may have many releases over its life — that is the whole point of this
 * migration — but it can never legitimately have two being PREPARED at once:
 * the second would bill retainage the first already covers. So the uniqueness
 * moves to the one state that is genuinely impossible, and the database stays
 * the serialization point rather than a read-then-write in application code.
 */
CREATE UNIQUE INDEX IF NOT EXISTS commercial_aia_one_draft_release_per_opp
  ON commercial_aia_applications (opportunity_id)
  WHERE is_retainage_release AND status = 'draft' AND deleted_at IS NULL;
