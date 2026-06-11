-- Replace the day-1 supplier_extras seed with Katie's actual product list
-- (Products Short List, categorized.xlsx, 2026-06-10).
--
-- Strategy:
--   1. Soft-deactivate (is_active=false) every row from the original 2026-06-04
--      seed so historical orders that referenced those IDs still resolve (the
--      row stays in place), but they DON'T appear in the worker dropdown.
--   2. Insert Katie's 20 sundries with deterministic UUIDs derived from the
--      product name → safe to re-run (ON CONFLICT DO NOTHING).
--   3. Use `category` field via the row's name (no schema change). Sort
--      values keep grouping consistent in the dropdown (Tape > Drop Cloths >
--      Caulk > Patching > Trays > Rollers).
--
-- Safe to re-run. The UPDATE ... WHERE name IN (...) is idempotent. Inserts
-- use ON CONFLICT DO NOTHING on the deterministic id.

-- 1. Soft-deactivate the original 20-item starter seed.
UPDATE supplier_extras
   SET is_active = false
 WHERE name IN (
   '9" microfiber roller cover',
   '9" roller frame',
   '2" angled sash brush',
   '3" flat brush',
   '4" mini roller (cabinets/trim)',
   '9x12 canvas drop cloth',
   '12oz painter''s tape (blue)',
   '1.5" painter''s tape (green/delicate)',
   '5-gallon plastic bucket',
   'Paint tray + liners (3-pack)',
   'Spackle / lightweight filler (32oz)',
   'Sanding sponge (medium grit)',
   '150-grit sandpaper (sheets)',
   'Caulk (paintable, white)',
   'Plastic sheeting (10x20)',
   'Mineral spirits / paint thinner',
   'Latex primer (gallon)',
   'Oil-based primer (gallon)',
   'Stain blocker (spot primer)',
   'Disposable gloves (box of 100)'
 );

-- 2. Insert Katie's list. Deterministic UUID = md5(name) prefix so the
--    migration is re-runnable. Sort order groups by sundry category so the
--    dropdown reads naturally: Tape → Drop Cloths → Caulk → Patching →
--    Trays → Rollers.
INSERT INTO supplier_extras (id, name, unit, default_qty, sort_order, is_active)
SELECT
  ('00000000-0000-0000-0000-' || substring(md5(name) from 1 for 12))::uuid,
  name, unit, qty, sort, true
FROM (VALUES
  -- Tape (10-19)
  ('3M 2" 2090 Blue Tape',                        'roll', 1, 10),
  ('3M 1 1/2" 2090 Blue Tape',                    'roll', 1, 11),
  -- Drop Cloths / Sheeting (20-29)
  ('3'' Roll Building Paper',                     'roll', 1, 20),
  ('12x400 ft .31 Plastic',                       'roll', 1, 21),
  ('9x400 ft .31 plastic',                        'roll', 1, 22),
  -- Caulk (30-39)
  ('DAP Dynaflex 230 White',                      'tube', 1, 30),
  ('DAP Alex Plus White Caulk 10oz',              'tube', 1, 31),
  ('DAP Alex Flex White 10 oz Caulk',             'tube', 1, 32),
  ('DAP Alex Fast Dry White 10oz',                'tube', 1, 33),
  -- Patching / Spackle (40-49)
  ('Easy Sand 20',                                'bag',  1, 40),
  ('Easy Sand 45',                                'bag',  1, 41),
  ('Plaster of Paris 25lb bag',                   'bag',  1, 42),
  ('5 Gal USG Green Joint Compound',              'pail', 1, 43),
  ('5 Gal Blue Top Compound',                     'pail', 1, 44),
  -- Trays (50-59)
  ('9" 5 Pack Tray Liners',                       'pack', 1, 50),
  ('4 Qt Tray Liner',                             'each', 1, 51),
  -- Rollers (60-69)
  ('4 inch microfiber roller covers 1/2 nap',     'each', 1, 60),
  ('4 inch microfiber roller covers 3/8 nap',     'each', 1, 61),
  ('9 inch microfiber 9/16 (4 pack)',             'pack', 1, 62),
  ('9 inch microfiber 9/16',                      'each', 1, 63)
) AS seed(name, unit, qty, sort)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE supplier_extras IS
  'Catalog of non-paint extras for the worker dropdown on supplier orders. Reseeded 2026-06-10 with Katie''s actual product list — Tape / Drop Cloths / Caulk / Patching / Trays / Rollers. Old default seed soft-deactivated (is_active=false) to preserve historical references.';
