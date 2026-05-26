-- Phase 2 — Per-supplier email templates
-- ------------------------------------------------------------------
-- Same architecture as customer_form_templates (migration 004) but keyed
-- by supplier_account_id so BM / SW / Romeo's can each have a different
-- greeting / format / signoff. NULL columns fall back to the code defaults
-- shipped in lib/supplier-order/templates.ts.
--
-- Variables substituted at send time:
--   {{supplier_name}}        — "Benjamin Moore"
--   {{ppp_account_number}}   — from supplier_settings.ppp_account_number
--   {{po_number}}            — auto-generated per order
--   {{customer_name}}        — from the customer-form token
--   {{customer_first}}       — customer's first name
--   {{wo_number}}            — work order number
--   {{required_by_date}}     — formatted date
--   {{fulfillment_method}}   — 'delivery' | 'pickup' (lowercase)
--   {{delivery_address_block}} — multi-line address block (delivery only)
--   {{pickup_location}}      — supplier branch (pickup only)
--   {{line_items_block}}     — pre-formatted color list per surface
--   {{extras_block}}         — pre-formatted extras list (empty when none)
--   {{special_instructions}} — admin freeform (empty when blank)
--   {{ppp_brand}}            — "Precision Painting Plus"
--
-- Safe to re-run via IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS supplier_email_templates (
  supplier_account_id TEXT PRIMARY KEY,
  -- Email parts (NULL = use code default)
  subject TEXT,
  greeting TEXT,
  intro TEXT,
  outro TEXT,
  signoff TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID
);

CREATE OR REPLACE FUNCTION supplier_email_templates_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS supplier_email_templates_touch_trigger ON supplier_email_templates;
CREATE TRIGGER supplier_email_templates_touch_trigger
  BEFORE UPDATE ON supplier_email_templates
  FOR EACH ROW
  EXECUTE FUNCTION supplier_email_templates_touch_updated_at();

COMMENT ON TABLE supplier_email_templates IS
  'Per-supplier email template overrides. NULL columns fall back to code defaults in lib/supplier-order/templates.ts. Editable via /dashboard/settings/templates (per-supplier section).';
