-- Migration 014: supplier_settings sort_order + is_bm_retailer columns.
--
-- Why: the Pick a Supplier modal used to read sort + BM-retailer flag from
-- loadSalesforceSnapshot() which cost ~10s on cold cache, making the modal
-- hang for up to a minute (Katie 2026-06-03). Both flags are static per
-- supplier so we store them directly on supplier_settings.
--
-- Default ordering Katie sent over 2026-06-03:
--   1. Aboffs
--   2. Willis Paint Place
--   3. Janovic
--   4. Stein Paint Medallions
--   5. Eco Wall Coatings
--   6. Ricciardi Brothers
--   7. Sunbelt   (always last)
--
-- Suppliers not in this list get NULL sort_order and fall to the end of
-- the picker alphabetically. Admins can re-seed via the drag-reorder UI
-- on /dashboard/settings/suppliers (separate ship).
--
-- Safe to re-run: every step IF NOT EXISTS-gated; UPDATEs target rows by
-- canonical name match.

ALTER TABLE supplier_settings
  ADD COLUMN IF NOT EXISTS sort_order INTEGER,
  ADD COLUMN IF NOT EXISTS is_bm_retailer BOOLEAN NOT NULL DEFAULT false;

-- Seed Katie's preferred order. ILIKE so we tolerate "Aboff's", "Aboffs", etc.
-- These UPDATEs are idempotent — re-running the migration just rewrites the
-- same values. We deliberately don't touch sort_order for any other supplier
-- (so manual reorders made via the UI later aren't clobbered).
UPDATE supplier_settings SET sort_order = 10 WHERE supplier_name ILIKE 'Aboff%';
UPDATE supplier_settings SET sort_order = 20 WHERE supplier_name ILIKE 'Willis%';
UPDATE supplier_settings SET sort_order = 30 WHERE supplier_name ILIKE 'Janovic%';
UPDATE supplier_settings SET sort_order = 40 WHERE supplier_name ILIKE 'Stein%';
UPDATE supplier_settings SET sort_order = 50 WHERE supplier_name ILIKE '%Eco Wall%';
UPDATE supplier_settings SET sort_order = 60 WHERE supplier_name ILIKE 'Ricciardi%';
UPDATE supplier_settings SET sort_order = 999 WHERE supplier_name ILIKE 'Sunbelt%';  -- always last

-- BM retailers — same brand-side mapping the snapshot used to compute. Updates
-- here mirror what Account.VendorBMRetailer__c in Salesforce says, but we
-- copy locally so the picker doesn't need a snapshot round-trip.
UPDATE supplier_settings SET is_bm_retailer = true WHERE supplier_name ILIKE 'Aboff%';
UPDATE supplier_settings SET is_bm_retailer = true WHERE supplier_name ILIKE 'Janovic%';
UPDATE supplier_settings SET is_bm_retailer = true WHERE supplier_name ILIKE 'Ricciardi%';
UPDATE supplier_settings SET is_bm_retailer = true WHERE supplier_name ILIKE 'Stein%';
UPDATE supplier_settings SET is_bm_retailer = true WHERE supplier_name ILIKE 'Willis%';

-- Ricciardi: Katie 2026-06-03: email is Greenbrook@ricciardibrothers.com.
-- Update only if the row exists + email is currently empty or different (so
-- we don't blow away an intentionally-different address PPP may set later).
UPDATE supplier_settings
  SET order_email = 'Greenbrook@ricciardibrothers.com'
  WHERE supplier_name ILIKE 'Ricciardi%'
    AND (order_email IS NULL OR order_email = '');
