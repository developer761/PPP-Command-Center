-- Migration 062 — Restructure two Tomco price-list entries into
-- parent → variation groups so the Product Library demonstrates
-- Katie's canonical example ("HM Frame & Wood Door" with Seal & Poly
-- and Stain/Seal/Poly variations underneath).
--
-- Source: /Users/karanmalhotra/Downloads/Tomco Price List.xlsx cross-
-- referenced against migration 051 seed. Two natural variation groups
-- exist in the raw list:
--
--   1. Doors & Frames — "HM Frame & Wood Door (Seal & Poly)" ($175)
--      + "HM Frame & Wood Door (Stain, Seal & Poly)" ($225) share the
--      same base product, differ only in the finish system. Katie
--      called this exact pair out as the reference example.
--
--   2. Wallcovering — "Wallcovering Install per lin.yd" ($25) +
--      "Wallcovering Install per sq.ft" ($2.10) share the same
--      product, differ only in the unit of measure billed. Same
--      variation pattern.
--
-- Approach: create a browse-header parent (no price of its own — F.6
-- server-side rejects picking a parent-only product on line items),
-- then flip the two existing children to point at the parent + carry
-- a variation_label. Parent SKUs use the "-PARENT" suffix so they
-- can't collide with the pre-existing child SKUs.
--
-- Idempotent: guarded with WHERE clauses that only fire if the
-- variation_label is NULL (unlinked). Safe to re-run — after first
-- apply, the WHERE-NULL guards short-circuit and this becomes a no-op.

-- ────────────────────────────────────────────────────────────────────
-- 1. HM Frame & Wood Door parent + link 2 variations
-- ────────────────────────────────────────────────────────────────────

INSERT INTO public.commercial_products
  (sku, name, category, unit, default_unit_price_cents, notes,
   surface_area, description)
VALUES
  ('TC-DF-PARENT-001', 'HM Frame & Wood Door', 'paint', 'each', 0,
   'Parent browse-header. Pick a variation below.',
   'interior',
   'Hollow-metal frame paired with a wood door. Two prep + finish systems available under this parent — pick Seal & Poly for a clear finish or Stain, Seal & Poly for a stained clear finish.')
ON CONFLICT (sku) WHERE deleted_at IS NULL DO NOTHING;

UPDATE public.commercial_products c
   SET parent_product_id = (
         SELECT id FROM public.commercial_products
          WHERE sku = 'TC-DF-PARENT-001' AND deleted_at IS NULL
          LIMIT 1
       ),
       variation_label = 'Seal & Poly',
       description = COALESCE(c.description, 'Frame paint + wood door clear finish.'),
       surface_area = 'interior'
 WHERE c.sku = 'TC-DF-004'
   AND c.variation_label IS NULL
   AND c.deleted_at IS NULL;

UPDATE public.commercial_products c
   SET parent_product_id = (
         SELECT id FROM public.commercial_products
          WHERE sku = 'TC-DF-PARENT-001' AND deleted_at IS NULL
          LIMIT 1
       ),
       variation_label = 'Stain, Seal & Poly',
       description = COALESCE(c.description, 'Frame paint + wood door stained clear finish.'),
       surface_area = 'interior'
 WHERE c.sku = 'TC-DF-005'
   AND c.variation_label IS NULL
   AND c.deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────────────
-- 2. Wallcovering Install parent + link 2 UOM variations
-- ────────────────────────────────────────────────────────────────────

INSERT INTO public.commercial_products
  (sku, name, category, unit, default_unit_price_cents, notes,
   surface_area, description)
VALUES
  ('TC-WC-PARENT-001', 'Wallcovering Install', 'labor', 'each', 0,
   'Parent browse-header. Pick a variation below.',
   'interior',
   'Wallcovering install labor. Priced by linear yard of material (contractor-quantified) or by square foot of coverage — pick whichever unit the GC quantified the material in.')
ON CONFLICT (sku) WHERE deleted_at IS NULL DO NOTHING;

UPDATE public.commercial_products c
   SET parent_product_id = (
         SELECT id FROM public.commercial_products
          WHERE sku = 'TC-WC-PARENT-001' AND deleted_at IS NULL
          LIMIT 1
       ),
       variation_label = 'Per Linear Yard',
       description = COALESCE(c.description, 'Install labor priced by linear yard of material.'),
       surface_area = 'interior'
 WHERE c.sku = 'TC-WC-003'
   AND c.variation_label IS NULL
   AND c.deleted_at IS NULL;

UPDATE public.commercial_products c
   SET parent_product_id = (
         SELECT id FROM public.commercial_products
          WHERE sku = 'TC-WC-PARENT-001' AND deleted_at IS NULL
          LIMIT 1
       ),
       variation_label = 'Per Square Foot',
       description = COALESCE(c.description, 'Install labor priced by square foot (alt to LY).'),
       surface_area = 'interior'
 WHERE c.sku = 'TC-WC-004'
   AND c.variation_label IS NULL
   AND c.deleted_at IS NULL;

-- Verify (Karan-facing sanity query):
--   SELECT p.name, p.sku, v.variation_label, v.sku AS variation_sku,
--          v.default_unit_price_cents/100.0 AS price
--     FROM public.commercial_products p
--     JOIN public.commercial_products v ON v.parent_product_id = p.id
--    WHERE p.deleted_at IS NULL AND v.deleted_at IS NULL
--    ORDER BY p.name, v.variation_label;
-- Expected after migration 062:
--   HM Frame & Wood Door       | Seal & Poly            | TC-DF-004 | 175.00
--   HM Frame & Wood Door       | Stain, Seal & Poly     | TC-DF-005 | 225.00
--   Wallcovering Install       | Per Linear Yard        | TC-WC-003 | 25.00
--   Wallcovering Install       | Per Square Foot        | TC-WC-004 | 2.10
