-- Migration 061 — Backfill surface_area on existing products.
--
-- Karan 2026-07-19: migration 060 defaulted every existing row to
-- surface_area='other' — technically correct (no data loss) but
-- practically useless (everything piles into the "Other" bucket in
-- the new grouped list view). This one-time pass uses SKU prefix +
-- name pattern matching to intelligently reclassify Tomco's 55 seeded
-- products (from migration 051) plus any Alex-added products.
--
-- Categorization rules (in priority order):
--   1. Explicit exterior signals win (SKU prefix TC-EX-, "Exterior" in
--      name, roof/bollard/facade/OH door/roll-up/line stripe/parking).
--   2. Interior groupings by SKU prefix (TC-IW/CE/WC/DF/TR are all
--      interior by default — commercial interior work is the common
--      case; explicitly-exterior products live under TC-EX-).
--   3. Interior signals via name pattern (ceiling, soffit, wallcovering,
--      trim, mantel, crown/base/chair moulding, radiator, corner guard).
--   4. Equipment + catch-all labor → 'other' (scissor lift, boom lift,
--      Labor Only, Dunage — none of these belong to a surface).
--   5. Fallback: preserve current value (only rows still at 'other'
--      are touched, so Alex-classified rows are never overwritten).
--
-- Safe to rerun — the WHERE clause guards on surface_area='other' so
-- re-executing this migration only touches rows that were never
-- manually classified. Alex can override any misclassification via
-- the product edit page.

UPDATE public.commercial_products
   SET surface_area = CASE

     -- ── Explicit EXTERIOR ─────────────────────────────────────────
     WHEN sku LIKE 'TC-EX-%'                                   THEN 'exterior'
     WHEN name ILIKE '%exterior%'                              THEN 'exterior'
     WHEN name ILIKE '%OH Door%'
       OR name ILIKE '%overhead door%'
       OR name ILIKE '%roll-up%'
       OR name ILIKE '%rolling door%'                          THEN 'exterior'
     WHEN name ILIKE '%roof%'
       OR name ILIKE '%bollard%'
       OR name ILIKE '%facade%'
       OR name ILIKE '%façade%'                                THEN 'exterior'
     WHEN name ILIKE '%line stri%'
       OR name ILIKE '%parking%'                               THEN 'exterior'
     WHEN name ILIKE '%power wash%'                            THEN 'exterior'
     WHEN name ILIKE '%precast concrete%'
       OR name ILIKE '%split face%'
       OR name ILIKE '%eifs%'
       OR name ILIKE '%stucco%'                                THEN 'exterior'
     WHEN name ILIKE '%gas pipe%'
       OR name ILIKE '%steel lintel%'
       OR name ILIKE '%drip cap%'
       OR name ILIKE '%pipe railing%'
       OR name ILIKE '%steel i beam%'                          THEN 'exterior'

     -- ── SKU-prefix INTERIOR groups (Tomco seed) ──────────────────
     WHEN sku LIKE 'TC-IW-%'                                   THEN 'interior'
     WHEN sku LIKE 'TC-CE-%'                                   THEN 'interior'
     WHEN sku LIKE 'TC-WC-%'                                   THEN 'interior'
     WHEN sku LIKE 'TC-DF-%'                                   THEN 'interior'
     WHEN sku LIKE 'TC-TR-%'                                   THEN 'interior'

     -- ── Name-based INTERIOR signals ──────────────────────────────
     WHEN name ILIKE '%interior%'                              THEN 'interior'
     WHEN name ILIKE '%ceiling%'
       OR name ILIKE '%soffit%'
       OR name ILIKE '%wallcovering%'
       OR name ILIKE '%wallpaper%'                             THEN 'interior'
     WHEN name ILIKE '%mantel%'
       OR name ILIKE '%crown mold%'
       OR name ILIKE '%base mold%'
       OR name ILIKE '%chair rail%'
       OR name ILIKE '%radiator%'
       OR name ILIKE '%wood cap%'
       OR name ILIKE '%stair trim%'                            THEN 'interior'
     WHEN name ILIKE '%corner guard%'                          THEN 'interior'
     WHEN name ILIKE '%floor paint%'                           THEN 'interior'
     WHEN name ILIKE '%hm door%'
       OR name ILIKE '%hm frame%'
       OR name ILIKE '%wood door%'
       OR name ILIKE '%door & frame%'
       OR name ILIKE '%side light%'                            THEN 'interior'
     WHEN name ILIKE '%window frame%'
       OR name ILIKE '%window sash%'                           THEN 'interior'
     WHEN name ILIKE '%gypsum%'
       OR name ILIKE '%drywall%'
       OR name ILIKE '%skim coat%'                             THEN 'interior'
     WHEN name ILIKE '%duct work%'
       OR name ILIKE '%ceiling grid%'
       OR name ILIKE '%deck & joist%'                          THEN 'interior'

     -- ── Equipment + agnostic labor → OTHER ───────────────────────
     WHEN name ILIKE '%scissor lift%'
       OR name ILIKE '%boom lift%'
       OR name ILIKE '%man lift%'                              THEN 'other'
     WHEN name ILIKE '%labor only%'
       OR name ILIKE 'labor %'
       OR name ILIKE '% labor'                                 THEN 'other'
     WHEN name ILIKE '%dunage%'
       OR name ILIKE '%dunnage%'                               THEN 'other'

     -- ── Interior columns (default guess — Alex can flip via UI) ──
     WHEN name ILIKE '%column%'                                THEN 'interior'

     -- Fallback: leave whatever's there.
     ELSE surface_area
   END
 WHERE surface_area = 'other';

-- Sanity report (Karan-facing — check after running):
--   SELECT surface_area, COUNT(*) FROM public.commercial_products
--     WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC;
-- Expected shape post-migration (from Tomco seed alone):
--   interior ~ 34   exterior ~ 16   other ~ 5   (Alex-added rows extra)
