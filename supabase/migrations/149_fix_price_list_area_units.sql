-- 149 — Correct linear_foot → square_foot on area-measured price-list rows
--
-- Brendan 2026-08-17: "The unit is incorrect on this inclusion. It should be
-- Square feet not LF."
--
-- Swept the whole seeded Tomco price list rather than the one row he pointed
-- at. Ten rows price AREA work but carry a LINEAR unit, and the rates prove
-- it: 'Paint Gypsum Wall 2 Coats' is $0.75/unit and 'Exterior CMU Walls -
-- Paint' is $2.00/unit — square-foot rates. The comparable rows that were
-- already correct sit right beside them ('Exterior CMU Walls - Power Wash &
-- Paint 2 Coats Elastomeric' at $2.75/square_foot). So the UNIT LABEL is the
-- defect; the prices are right and are deliberately left alone.
--
-- Genuinely linear rows are NOT touched: drip cap, gas pipes, steel lintels,
-- pipe railing, caulk control joints, steel I-beams, soffits, exposed duct,
-- base/crown/chair-rail/wood-cap trim, radiators, line striping.
--
-- Scoped by SKU so a hand-edited unit on a customer's own product is safe, and
-- guarded on the current value so re-running can't clobber a later correction.
-- Existing proposal LINE ITEMS keep their snapshotted unit on purpose — a
-- proposal already sent must not silently change after the fact.

UPDATE commercial_products
   SET unit = 'square_foot',
       updated_at = now()
 WHERE unit = 'linear_foot'
   AND sku IN (
     -- Interior walls: gypsum, wood and CMU are all measured by area.
     'TC-IW-001',  -- Paint Gypsum Wall 2 Coats
     'TC-IW-002',  -- Skim Coat Gypsum Walls
     'TC-IW-003',  -- Prime & Paint Gypsum Walls 2 Coats
     'TC-IW-004',  -- Prime & Paint Wood Walls 2 Coats
     'TC-IW-005',  -- Interior CMU Walls - Block Fill & Paint 1 Coat
     'TC-IW-006',  -- Wood Walls Clear Coat
     -- Exterior surface work measured by area.
     'TC-EX-006',  -- Power Washing
     'TC-EX-008',  -- Exterior CMU Walls - Paint
     -- Wallcovering prep is per square foot of wall.
     'TC-WC-001',  -- Wallcovering Removal
     'TC-WC-002'   -- Wallcovering Primer
   );
