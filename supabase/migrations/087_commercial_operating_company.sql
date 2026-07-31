-- 087 · Operating Company (2026-08)
-- A single configurable "who we are" identity that flows into every generated
-- document (proposals, invoices, AIA, transmittals, warranty, work order,
-- statement) — replaces the hardcoded "Precision Painting Plus" strings + the
-- scattered PPP_BRAND / TOMCO_COMPANY_FOOTER constants. Singleton: the boolean
-- PK pinned to TRUE guarantees exactly one row.
--
-- Idempotent (hand-pasted into the Supabase SQL editor). Seeds Tomco Painting.

CREATE TABLE IF NOT EXISTS commercial_operating_company (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  name                 text NOT NULL DEFAULT 'Tomco Painting',
  legal_name           text,
  address_line1        text,
  address_line2        text,
  city                 text,
  state                text,
  zip                  text,
  phone                text,
  fax                  text,
  email                text,
  website              text,
  -- object keys in the commercial-brand-assets bucket (Phase 0B); nullable
  -- until a logo / signature is uploaded.
  logo_asset_key       text,
  signature_asset_key  text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id   uuid
);

-- Seed the one row with Tomco's real identity (from the warranty + proposal
-- footer). ON CONFLICT DO NOTHING so re-running never clobbers edits.
INSERT INTO commercial_operating_company
  (id, name, legal_name, address_line1, address_line2, city, state, zip, phone, fax, website)
VALUES
  (true, 'Tomco Painting', 'Tomco Painting', '77 Windsor Place, Ste. 13', NULL,
   'Central Islip', 'NY', '11722', '631.582.2770', '631.582.2771', 'www.tomcopainting.com')
ON CONFLICT (id) DO NOTHING;
