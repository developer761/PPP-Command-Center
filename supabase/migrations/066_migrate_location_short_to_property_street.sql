-- ────────────────────────────────────────────────────────────────────
-- Migration 066 — Migrate location_short → property_street
-- ────────────────────────────────────────────────────────────────────
-- Karan 2026-07-20 (Phase G Q2): kill the legacy `location_short`
-- freeform address field. The structural `property_street/city/state`
-- fields are the source of truth now (Fill-from-deal picker + PDF
-- renderer + hydrate all prefer structural).
--
-- Conservative migration:
--   1. Copy location_short → property_street ONLY where street is NULL.
--      Any row with structural already populated stays untouched.
--   2. This migration does NOT drop the column. The column drop happens
--      in migration 068 (later batch) after code readers are removed.
--      Doing it in two passes lets the app deploy cleanly — otherwise
--      any surviving reader of opp.location_short would crash on prod.
--
-- Idempotent — WHERE guard on property_street IS NULL. Safe to re-run.

UPDATE public.commercial_opportunities
   SET property_street = location_short
 WHERE property_street IS NULL
   AND location_short IS NOT NULL
   AND TRIM(location_short) != ''
   AND deleted_at IS NULL;

-- Log how many rows were migrated (visible in psql output).
DO $$
DECLARE
  migrated INT;
  remaining INT;
BEGIN
  SELECT COUNT(*) INTO migrated
    FROM public.commercial_opportunities
   WHERE property_street IS NOT NULL
     AND property_street = location_short
     AND deleted_at IS NULL;
  SELECT COUNT(*) INTO remaining
    FROM public.commercial_opportunities
   WHERE location_short IS NOT NULL
     AND TRIM(location_short) != ''
     AND deleted_at IS NULL;
  RAISE NOTICE 'Migration 066: % rows had location_short backfilled into property_street. % rows still have populated location_short (untouched because property_street was already set).', migrated, remaining;
END $$;
