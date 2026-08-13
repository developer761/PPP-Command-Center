-- 133 · rfp_received_at becomes a DATE, like every other date on the deal
--
-- Backlog §4.2 recorded this as latent, on the grounds that "both write paths
-- treat it identically". They do not. There are three, and two store the wrong
-- day:
--
--   1. Opportunities create form  → "2026-08-12"              (bare)
--   2. Account create/edit forms  → "2026-08-12T12:00:00.000Z" (noon UTC)
--   3. Inline field editor        → "2026-08-12"              (bare)
--
-- Written into a TIMESTAMPTZ, a bare date is UTC MIDNIGHT — 8pm the previous
-- evening in Eastern. So paths 1 and 3 stored the day BEFORE the one the user
-- picked, and the "Plans received" tile read it back a day early. Path 2, which
-- anchors at noon, was right. The same date typed on two screens produced two
-- different stored days.
--
-- The column is a calendar date. It has no time and no zone — nobody records
-- that plans arrived at 14:32:07-04. Making it a DATE removes the trap rather
-- than patching the three callers and waiting for a fourth.
--
-- REPAIRING HISTORY
-- The USING clause truncates in UTC, not Eastern, and that is deliberate:
-- both write conventions put the day the user typed in the UTC portion
-- (midnight for the bare paths, noon for the anchored one), so the UTC date IS
-- the typed date in every case. Truncating in Eastern instead would "fix" the
-- correct rows and bake the bug into the broken ones.
--
-- Safe to re-run: the DO block checks the current type first.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'commercial_opportunities'
      AND column_name = 'rfp_received_at'
      AND data_type = 'timestamp with time zone'
  ) THEN
    ALTER TABLE public.commercial_opportunities
      ALTER COLUMN rfp_received_at TYPE DATE
      USING (rfp_received_at AT TIME ZONE 'UTC')::date;
  END IF;
END $$;

COMMENT ON COLUMN public.commercial_opportunities.rfp_received_at IS
  'Katie ask #3 — the date plans/the RFP arrived. DATE, not TIMESTAMPTZ: it is
   a calendar day, and storing it with a zone made a bare-date write land on
   the previous Eastern day (migration 133). Feeds time-to-proposal
   (proposal.sent_at - rfp_received_at).';

-- ── Post-flight ───────────────────────────────────────────────────────────
-- Expect data_type = 'date':
--   SELECT data_type FROM information_schema.columns
--    WHERE table_name='commercial_opportunities' AND column_name='rfp_received_at';
--
-- Expect 0 rows — nothing should read as a timestamp any more:
--   SELECT count(*) FROM public.commercial_opportunities
--    WHERE rfp_received_at IS NOT NULL
--      AND rfp_received_at::text ~ 'T|:';
