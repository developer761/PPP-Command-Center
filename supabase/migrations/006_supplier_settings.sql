-- Phase 2 — Per-supplier configuration
-- ------------------------------------------------------------------
-- One row per supplier (BM, SW, Romeo's, etc.) holding the config admin
-- can edit without a deploy: where to email orders, PPP's account number
-- with that supplier, pickup-branch locations.
--
-- Until Katie provides values, rows can stay empty and the supplier order
-- modal shows a "set this in Settings → Suppliers" hint on the Send button.
-- The Copy-to-Clipboard button works without any config, so PPP gets value
-- on day 1 regardless.
--
-- supplier_account_id is the SF Account.Id of the supplier (PPP models
-- paint suppliers as Accounts with Type IN ('Retail Vendor','Service Vendor')).
--
-- Safe to re-run via IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS supplier_settings (
  supplier_account_id TEXT PRIMARY KEY,
  supplier_name TEXT NOT NULL,
  -- Where orders are sent. Plain mailbox address. Multiple recipients
  -- can be configured later by switching to TEXT[] or a CSV split.
  order_email TEXT,
  -- PPP's account number with this supplier. Substituted into the email
  -- template at send time. Format: free string (BM uses contractor numbers,
  -- SW uses pro account numbers — both go through this field).
  ppp_account_number TEXT,
  -- Pickup locations — list of supplier branches PPP staff can pick up at.
  -- Shape: [{ name: "Smithtown", address: "..." }] — rendered as a dropdown
  -- when fulfillment_method='pickup' on the order modal.
  pickup_locations JSONB DEFAULT '[]'::jsonb,
  -- Optional override for which template variant applies to this supplier.
  -- When NULL, the default code template applies. Set per-supplier when
  -- BM and SW want different greeting / format / signoff.
  preferred_template_key TEXT,
  -- Soft-disable flag for sunsetting suppliers PPP no longer uses
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID
);

CREATE INDEX IF NOT EXISTS supplier_settings_active_idx
  ON supplier_settings (is_active)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION supplier_settings_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS supplier_settings_touch_trigger ON supplier_settings;
CREATE TRIGGER supplier_settings_touch_trigger
  BEFORE UPDATE ON supplier_settings
  FOR EACH ROW
  EXECUTE FUNCTION supplier_settings_touch_updated_at();

COMMENT ON TABLE supplier_settings IS
  'Per-supplier config (order email, PPP account number, pickup locations). Editable via /dashboard/settings/suppliers. Awaits Katie for the actual values.';
