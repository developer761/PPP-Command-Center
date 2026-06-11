-- Per-supplier flags Katie called out 2026-06-10:
--
--   phone_only       — supplier doesn't accept email orders, only phone.
--                      The supplier-order-modal hides the Send/Copy email
--                      buttons and shows a "Call this supplier" panel
--                      with the number to dial. Workers see a 📞 badge
--                      on the picker row.
--
--   phone_number     — the digits to call when phone_only=true. Plain
--                      string, no normalization (so admin can paste
--                      whatever format Katie uses — Twilio's not in this
--                      path).
--
--   pickup_default   — flag for suppliers where pickup is the default
--                      fulfillment regardless of the customer's address.
--                      Katie 2026-06-10: NYC suppliers don't generally
--                      deliver because there's nowhere to drop the paint
--                      unless workers are on-site. When this is true the
--                      modal opens with fulfillment_method=pickup
--                      pre-selected and the pickup-location dropdown
--                      visible. Admin can still toggle to delivery for
--                      the one-off case.
--
-- Safe to re-run via IF NOT EXISTS guards on each ALTER.

ALTER TABLE supplier_settings
  ADD COLUMN IF NOT EXISTS phone_only BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE supplier_settings
  ADD COLUMN IF NOT EXISTS phone_number TEXT;

ALTER TABLE supplier_settings
  ADD COLUMN IF NOT EXISTS pickup_default BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN supplier_settings.phone_only IS
  'Supplier accepts phone orders only — no email. UI suppresses Send button and shows the phone number to call instead.';

COMMENT ON COLUMN supplier_settings.phone_number IS
  'Phone digits for phone_only suppliers. Free-form string; not normalized.';

COMMENT ON COLUMN supplier_settings.pickup_default IS
  'When true, the supplier-order-modal opens with fulfillment_method=pickup pre-selected. Used for NYC suppliers where delivery is impractical (Janovic, Ricciardi, etc.). Admin can override per-order.';
