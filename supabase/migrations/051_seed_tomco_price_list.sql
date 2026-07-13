-- Migration 051 — Seed the Tomco Price List into commercial_products.
--
-- Karan 2026-07-13: source-of-truth spreadsheet at
-- ~/Desktop/Tomco Price List.xlsx (55 line items across 7 categories:
-- Interior Walls, Exterior, Wallcovering, Ceilings, Doors & Frames,
-- Trim, Miscellaneous).
--
-- Reconciliation notes vs the source XLSX:
--   1. Rows 27/28/29 had unit="LF" in the sheet but the DESCRIPTION
--      says "per lin.yd" or "per sq.ft". Trusting the description
--      because that's how estimators price them. Result: LY on 27+29,
--      SF on 28.
--   2. Row 63 ("Labor Only") has unit="Ea Hr" — normalized to hour.
--   3. Row 22 ("Exterio Split Face Block") has typo "Exterio" (missing
--      "r") in the source. Fixed to "Exterior" on the seed.
--   4. Row 28 typo "Wallcoverng" in source — fixed to "Wallcovering".
--   5. Row 46 typo "Windor Frame" — fixed to "Window Frame".
--   6. Row 59 "Dunage" — this is jobsite jargon for the wooden pallets
--      the wallcovering rolls ship on. Kept as-is (that's the term
--      estimators recognize).
--
-- SKUs follow pattern: TC-<CATEGORY_PREFIX>-<SEQ>. Numeric prefix keeps
-- them sortable + collision-proof if PPP later imports Sherwin/BM SKUs
-- into the same catalog (which have their own SKU convention).
--
-- Idempotent + rerun-safe via ON CONFLICT (sku) DO NOTHING — reruns
-- won't create duplicates and won't overwrite manual edits Alex/Katie
-- have made post-seed.
--
-- Prices are the Tomco list rate as of 2026-07-13. To create Tomco-
-- specific overrides at a different rate, use the Products admin UI's
-- customer-price section (they get inserted into commercial_customer_prices).

INSERT INTO public.commercial_products
  (sku, name, category, unit, default_unit_price_cents, notes)
VALUES
  -- ── Interior Walls (6) ──
  ('TC-IW-001', 'Paint Gypsum Wall 2 Coats', 'paint', 'linear_foot', 75, 'Standard interior wall paint (2 coats over existing).'),
  ('TC-IW-002', 'Skim Coat Gypsum Walls', 'paint', 'linear_foot', 125, 'Prep only — skim coat for level-4 finish.'),
  ('TC-IW-003', 'Prime & Paint Gypsum Walls 2 Coats', 'paint', 'linear_foot', 100, 'Primer + 2 finish coats on new/patched drywall.'),
  ('TC-IW-004', 'Prime & Paint Wood Walls 2 Coats', 'paint', 'linear_foot', 100, 'Wood substrate — primer + 2 finish coats.'),
  ('TC-IW-005', 'Interior CMU Walls - Block Fill & Paint 1 Coat', 'paint', 'linear_foot', 100, 'Block fill primer + 1 top coat on CMU.'),
  ('TC-IW-006', 'Wood Walls Clear Coat', 'paint', 'linear_foot', 100, 'Natural wood — clear coat only.'),

  -- ── Exterior (15) ──
  ('TC-EX-001', 'Bollards', 'paint', 'each', 5000, 'Per bollard, prep + 2 coats.'),
  ('TC-EX-002', 'Roof Ladder', 'paint', 'each', 50000, 'Prep + paint fixed roof ladder.'),
  ('TC-EX-003', 'Drip Cap', 'paint', 'linear_foot', 500, 'Exterior metal drip cap.'),
  ('TC-EX-004', 'Gas Pipes', 'paint', 'linear_foot', 500, 'Exterior gas piping.'),
  ('TC-EX-005', 'Steel Lintels', 'paint', 'linear_foot', 500, 'Exterior steel lintels.'),
  ('TC-EX-006', 'Power Washing', 'labor', 'linear_foot', 50, 'Standalone power-wash (surface prep).'),
  ('TC-EX-007', 'Steel I Beams', 'paint', 'linear_foot', 1000, 'Structural steel exposed exterior.'),
  ('TC-EX-008', 'Exterior CMU Walls - Paint', 'paint', 'linear_foot', 200, 'Existing exterior CMU paint refresh.'),
  ('TC-EX-009', 'Pipe Railing', 'paint', 'linear_foot', 1000, 'Metal pipe railing.'),
  ('TC-EX-010', 'Caulk Control Joints', 'sundry', 'linear_foot', 700, 'Exterior caulk control-joint sealing.'),
  ('TC-EX-011', 'Precast Concrete Panels - Power Wash & Paint 2 Coats Loxon', 'paint', 'square_foot', 250, 'Loxon (masonry primer/finish) — precast concrete.'),
  ('TC-EX-012', 'Standing Seam Roof - Prep & Paint', 'paint', 'square_foot', 500, 'Metal roof — prep + paint.'),
  ('TC-EX-013', 'Exterior CMU Walls - Power Wash & Paint 2 Coats Elastomeric Flat', 'paint', 'square_foot', 275, 'Elastomeric on exterior CMU — power wash + 2 coats.'),
  ('TC-EX-014', 'Exterior Split Face Block - Power Wash & Apply 2 Coats Okon Plugger', 'paint', 'square_foot', 175, 'Split-face block — Okon Plugger sealer.'),
  ('TC-EX-015', 'Exterior EIFS - Paint 2 Coats Flat', 'paint', 'square_foot', 200, 'EIFS system — flat finish 2 coats.'),

  -- ── Wallcovering (5) ──
  ('TC-WC-001', 'Wallcovering Removal', 'labor', 'linear_foot', 125, 'Strip existing wallcovering.'),
  ('TC-WC-002', 'Wallcovering Primer', 'sundry', 'linear_foot', 50, 'Prime walls before wallcovering install.'),
  ('TC-WC-003', 'Wallcovering Install per lin.yd', 'labor', 'linear_yard', 2500, 'Install labor priced by linear yard of material.'),
  ('TC-WC-004', 'Wallcovering Install per sq.ft', 'labor', 'square_foot', 210, 'Install labor priced by square foot (alt to LY).'),
  ('TC-WC-005', 'Wallcovering Supply per lin.yd', 'sundry', 'linear_yard', 2500, 'Material supply component (contractor-owned vs specified).'),

  -- ── Ceilings (5) ──
  ('TC-CE-001', 'Exposed Ceiling Deck & Joist', 'paint', 'square_foot', 115, 'Open-plenum industrial ceiling paint.'),
  ('TC-CE-002', 'Drywall Ceiling', 'paint', 'square_foot', 100, 'GWB ceiling paint.'),
  ('TC-CE-003', 'Soffits', 'paint', 'linear_foot', 500, 'Soffit painting per LF.'),
  ('TC-CE-004', 'Exposed Duct Work', 'paint', 'linear_foot', 1500, 'Exposed HVAC ductwork paint.'),
  ('TC-CE-005', 'Ceiling Grid', 'paint', 'square_foot', 50, 'Suspended ceiling grid (T-bar) paint.'),

  -- ── Doors & Frames (8) ──
  ('TC-DF-001', 'HM Frame - Prep & Paint 2 Coats', 'paint', 'each', 10000, 'Hollow metal frame only.'),
  ('TC-DF-002', 'HM Door - Prep & Paint 2 Coats', 'paint', 'each', 10000, 'Hollow metal door only.'),
  ('TC-DF-003', 'Wood Door - Stain, Seal, & Poly', 'paint', 'each', 12500, 'Natural wood door — stain finish system.'),
  ('TC-DF-004', 'HM Frame & Wood Door (Seal & Poly)', 'paint', 'each', 17500, 'Frame paint + wood door clear finish.'),
  ('TC-DF-005', 'HM Frame & Wood Door (Stain, Seal & Poly)', 'paint', 'each', 22500, 'Frame paint + wood door stained clear finish.'),
  ('TC-DF-006', 'Door & Frame - Prep & Paint 2 Coats', 'paint', 'each', 17500, 'Standard door + frame combo, both painted.'),
  ('TC-DF-007', 'OH Door Frame', 'paint', 'each', 15000, 'Overhead door frame (roll-up/coiling).'),
  ('TC-DF-008', 'Side Light', 'paint', 'each', 15000, 'Fixed sidelite panel adjacent to door.'),

  -- ── Trim (9) ──
  ('TC-TR-001', 'Window Frame - Prep & Paint 2 Coats', 'paint', 'each', 7500, 'Fixed window frame paint per opening.'),
  ('TC-TR-002', 'Window Sash - Prep & Paint 2 Coats', 'paint', 'each', 17500, 'Operable window sash — paint.'),
  ('TC-TR-003', 'Stair Trim per flight', 'paint', 'each', 150000, 'Per flight of stairs — all trim.'),
  ('TC-TR-004', 'Fireplace Mantel - Prep & Paint 2 Coats', 'paint', 'each', 20000, 'Fireplace mantel + surround paint.'),
  ('TC-TR-005', 'Base Molding - Prep & Paint 2 Coats', 'paint', 'linear_foot', 500, 'Baseboard trim paint.'),
  ('TC-TR-006', 'Wood Cap - Prep & Paint 2 Coats', 'paint', 'linear_foot', 500, 'Wood cap trim paint.'),
  ('TC-TR-007', 'Radiators - Prep & Paint 2 Coats', 'paint', 'linear_foot', 500, 'Cast-iron radiator paint (heat-safe).'),
  ('TC-TR-008', 'Chair Rail - Prep & Paint 2 Coats', 'paint', 'linear_foot', 500, 'Chair-rail trim.'),
  ('TC-TR-009', 'Crown Molding - Prep & Paint 2 Coats', 'paint', 'linear_foot', 1000, 'Crown molding paint.'),

  -- ── Miscellaneous (8) ──
  ('TC-MI-001', 'Columns - Paint 2 Coats', 'paint', 'each', 17500, 'Per column — round or rectangular.'),
  ('TC-MI-002', 'Scissor Lift - 1 Month', 'other', 'each', 350000, 'Equipment rental — scissor lift monthly rate.'),
  ('TC-MI-003', 'Boom Lift - 1 Month', 'other', 'each', 500000, 'Equipment rental — boom lift monthly rate.'),
  ('TC-MI-004', 'Dunage', 'sundry', 'each', 40000, 'Wallcovering roll pallet/dunnage handling charge.'),
  ('TC-MI-005', 'Corner Guard - Paint', 'paint', 'each', 2500, 'Corner guard prep + paint.'),
  ('TC-MI-006', 'Line Striping', 'paint', 'linear_foot', 500, 'Floor / parking line striping.'),
  ('TC-MI-007', 'Floor Paint', 'paint', 'square_foot', 300, 'Interior floor paint (concrete or epoxy).'),
  ('TC-MI-008', 'Labor Only', 'labor', 'hour', 6250, 'T&M labor rate — general painter hour.')

-- Match the partial unique index in migration 050 (WHERE deleted_at IS NULL)
-- so reruns don't error out with "no unique constraint matching ON CONFLICT".
ON CONFLICT (sku) WHERE deleted_at IS NULL DO NOTHING;
