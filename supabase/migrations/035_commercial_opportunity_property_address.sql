-- Migration 035: Property / Project Address on commercial_opportunities
--
-- Diagram (PPP Commercial Operating System, Phase 2) lists "Property /
-- Project Address" as first-class Opp info. Until now we leaned on the
-- account's site/billing address — but the same property-mgmt account
-- may have us bidding at multiple physical sites, so we need per-opp.
--
-- Paste this in the Supabase SQL Editor. IF NOT EXISTS-safe so re-running
-- is a no-op. Existing rows keep NULL property fields and the UI falls
-- back to the parent account's site/billing address (lib reads both and
-- prefers the opp-level value when present).
--
-- Side-effect-free: no triggers, no view rewrites. Only ALTER TABLE.

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS property_street TEXT,
  ADD COLUMN IF NOT EXISTS property_city   TEXT,
  ADD COLUMN IF NOT EXISTS property_state  TEXT,
  ADD COLUMN IF NOT EXISTS property_zip    TEXT;

COMMENT ON COLUMN public.commercial_opportunities.property_street IS
  'Per-opp project address. NULL means "same as parent account site/billing address" — UI shows the account fallback in that case. Lets a single property-mgmt account own bids at distinct physical sites.';

-- Helpful partial index for the rare "show me opps in NYC" filter Alex
-- mentioned. Tiny — most opps will have NULL property_city in v1.
CREATE INDEX IF NOT EXISTS idx_commercial_opportunities_property_city
  ON public.commercial_opportunities (property_city)
  WHERE property_city IS NOT NULL AND deleted_at IS NULL;
