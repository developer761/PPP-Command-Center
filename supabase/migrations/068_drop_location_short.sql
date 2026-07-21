-- ────────────────────────────────────────────────────────────────────
-- Migration 068 — Drop the retired `location_short` column
-- ────────────────────────────────────────────────────────────────────
-- Karan 2026-07-21 (2026-07-21 audit finding): migration 066 backfilled
-- location_short → property_street and explicitly deferred the column
-- drop to "migration 068 (later batch) after code readers are removed."
-- That migration was never written — the folder jumped 067 → 069, leaving
-- the schema half-migrated: the dead column was still live, still in the
-- TS type, and still read as a fallback in derivedOppName. This closes the
-- gap. (069 section E independently built the new property_street dedup
-- index; the OLD location_short index from migration 046 is dropped here.)
--
-- PRECONDITION (satisfied 2026-07-21): every code reader of
-- `location_short` has been removed —
--   • CommercialOpportunity type field dropped (db.ts)
--   • derivedOppName property_street-vs-location_short fallback removed
--   • duplicates.ts / hydrate.ts already read property_street
-- All row queries use `select("*")`, so removing the column just drops it
-- from the result shape — no explicit column list to update.
--
-- DEPLOY ORDER: ship the code (readers removed) FIRST, then apply this
-- migration. Applying it against the OLD code would break derivedOppName's
-- fallback read. Safe to run once the current deploy is live.
--
-- Idempotent — IF EXISTS guards on both the index and the column. Safe to
-- re-run.

-- (1) Drop the stale duplicate-detection index from migration 046. It was
--     built on LOWER(location_short); migration 069 replaced it with
--     commercial_opportunities_dup_detect_property_idx on property_street.
--     Dropping the column would cascade this away, but do it explicitly so
--     the intent is legible in the migration history.
DROP INDEX IF EXISTS public.commercial_opportunities_dup_detect_idx;

-- (2) Drop the column itself.
ALTER TABLE public.commercial_opportunities
  DROP COLUMN IF EXISTS location_short;

-- Verification (visible in psql output).
DO $$
DECLARE
  col_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'commercial_opportunities'
      AND column_name = 'location_short'
  ) INTO col_exists;

  IF col_exists THEN
    RAISE WARNING 'Migration 068: location_short column still present — drop did not take effect.';
  ELSE
    RAISE NOTICE 'Migration 068: location_short column dropped. property_street is now the sole site-address field.';
  END IF;
END $$;
