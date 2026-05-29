-- 012_seed_delivery_vendors.sql
-- Seed the supplier picker with PPP's real ordering vendors (the list Katie
-- sent, 2026-05-29). These are STORES PPP buys paint from (Aboffs sells BM/SW/
-- Behr, etc.) — NOT paint manufacturers — so a work order's colors never
-- auto-match them by manufacturer. They surface in the materials "Pick a
-- supplier" picker (the manual flow), which attributes the WO's colors to the
-- chosen store.
--
-- supplier_account_id uses a synthetic "vendor-<slug>" key (these vendors
-- aren't SF Accounts); /api/suppliers/active falls back to supplier_name when
-- the id isn't in the SF snapshot, so the picker renders fine.
--
-- Each vendor's store address is seeded as a pickup_location so the pickup
-- dropdown works. ppp_account_number is left NULL (Katie didn't provide them) —
-- admin can add later in Settings → Suppliers; the email just omits that line.
--
-- ON CONFLICT DO NOTHING so re-running is a no-op and never clobbers an edit an
-- admin makes later in the Suppliers editor.
--
-- Ricciardi Brothers has no order email (phone-only on Katie's list), so it's
-- seeded inactive — it won't appear in the picker until an email is added
-- (Send needs an address). Everything else is active.

INSERT INTO supplier_settings
  (supplier_account_id, supplier_name, order_email, pickup_locations, is_active)
VALUES
  ('vendor-aboffs', 'Aboffs', 'westhempstead@aboffs.com',
    '[{"name":"West Hempstead","address":"360 Hempstead Turnpike, West Hempstead, NY 11552"}]'::jsonb, true),
  ('vendor-willis-paint-place', 'Willis Paint Place', 'paintplaceny@gmail.com',
    '[{"name":"Williston Park","address":"263 Hillside Avenue, Williston Park, NY 11596"}]'::jsonb, true),
  ('vendor-janovic', 'Janovic', 'accountsreceivable@janovic.com',
    '[{"name":"Manhattan (3rd Ave)","address":"196 3rd Ave, New York, NY 10003"}]'::jsonb, true),
  ('vendor-medallion-paint-world', 'Medallions Paint World', 'orders@medallionpaintpw.com',
    '[{"name":"Fort Lauderdale","address":"5020 South State Road #7, Fort Lauderdale, FL 33314"}]'::jsonb, true),
  ('vendor-sunbelt-rentals', 'Sunbelt Rentals (equipment)', 'carol.flammia@sunbeltrentals.com',
    '[{"name":"Expressway Dr N","address":"3665 Expressway Dr North"}]'::jsonb, true),
  ('vendor-eco-wall-coatings', 'Eco Wall Coatings', 'info@ecowallcoatings.com',
    '[{"name":"SW 120th St","address":"14291 SW 120th St Suite 110"}]'::jsonb, true),
  ('vendor-stein-paint', 'Stein Paint', 'lance@steinpaint.com',
    '[{"name":"Miami","address":"545 W Flagler St, Miami, FL 33130"}]'::jsonb, true),
  ('vendor-ricciardi-brothers', 'Ricciardi Brothers Paint', NULL,
    '[{"name":"Maplewood","address":"1915 Springfield Ave, Maplewood, NJ 07040"}]'::jsonb, false)
ON CONFLICT (supplier_account_id) DO NOTHING;
