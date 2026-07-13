-- Migration 050 — Phase D: Product Library + Customer-Specific Prices.
--
-- Karan 2026-07-13: kickoff of Phase D per docs/PHASE_D_PLAN.md.
--
-- Introduces:
--   1. `commercial_products`         — SKU catalog (paint, sundries, labor)
--   2. `commercial_customer_prices`  — per-account negotiated overrides
--                                       (Tomco's price list mechanism)
--   3. `product_id` column on `commercial_invoice_line_items` — nullable
--      FK back to the catalog so future price changes don't rewrite
--      history, and reports can trace what SKU each line item came from.
--
-- Resolution rule (application layer, `lib/commercial/products/pricing.ts`):
--   1. If accountId is passed AND a `commercial_customer_prices` row
--      exists for (account, product) with `effective_from <= today`,
--      use its unit_price_cents.
--   2. Otherwise fall back to `commercial_products.default_unit_price_cents`.
--
-- Idempotent + rerun-safe.

-- ────────────────────────────────────────────────────────────────────
-- 1. commercial_products
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commercial_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  unit TEXT NOT NULL DEFAULT 'each',
  default_unit_cost_cents INTEGER,
  default_unit_price_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.commercial_products IS
  'Phase D catalog of paint SKUs, sundries, labor items. Line items on
   invoices/proposals pick from this table via ProductPicker. Migration
   050, 2026-07-13.';

COMMENT ON COLUMN public.commercial_products.category IS
  'One of: paint / sundry / labor / other. Application-enforced enum
   (kept as TEXT so admins can add categories without a schema change).';

COMMENT ON COLUMN public.commercial_products.unit IS
  'One of: gallon / hour / each / linear_foot / square_foot. Same
   application-enforced pattern as category.';

COMMENT ON COLUMN public.commercial_products.is_active IS
  'Archive without deleting. Inactive products stay usable on historical
   line items but are hidden from the ProductPicker default view.';

-- Unique SKU across the live catalog (soft-deleted rows can reuse the
-- SKU). Partial UNIQUE index preserves the freed SKU for a new active
-- entry after archive.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_products_sku_live_idx
  ON public.commercial_products (sku)
  WHERE deleted_at IS NULL;

-- Fast picker lookup: active + not-deleted + sortable by name.
CREATE INDEX IF NOT EXISTS commercial_products_active_name_idx
  ON public.commercial_products (name)
  WHERE deleted_at IS NULL AND is_active = true;

-- Filter by category for the admin surface.
CREATE INDEX IF NOT EXISTS commercial_products_category_idx
  ON public.commercial_products (category)
  WHERE deleted_at IS NULL;

-- Trigger to touch updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION public.commercial_products_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commercial_products_touch_updated_at_trigger
  ON public.commercial_products;
CREATE TRIGGER commercial_products_touch_updated_at_trigger
  BEFORE UPDATE ON public.commercial_products
  FOR EACH ROW
  EXECUTE FUNCTION public.commercial_products_touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 2. commercial_customer_prices
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commercial_customer_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL
    REFERENCES public.commercial_accounts(id) ON DELETE CASCADE,
  product_id UUID NOT NULL
    REFERENCES public.commercial_products(id) ON DELETE CASCADE,
  unit_price_cents INTEGER NOT NULL,
  effective_from DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.commercial_customer_prices IS
  'Phase D per-customer price overrides. When a customer (e.g. Tomco)
   negotiates rates that differ from the default catalog price, one row
   per (account, product, effective_from) captures the override. The
   application-layer resolveProductPrice() picks the newest override
   with effective_from <= today, falling back to the default catalog
   price. Migration 050, 2026-07-13.';

COMMENT ON COLUMN public.commercial_customer_prices.effective_from IS
  'Optional. NULL means "always" (retroactive to catalog creation).
   Setting a future date schedules a rate change without disturbing
   currently-active pricing.';

-- One rate per (account, product) per activation date. Two future
-- schedules for the same SKU with different dates are OK.
--
-- coalesce() so the NULL activation date collapses into a canonical
-- sentinel — otherwise Postgres treats NULLs as never-equal and two
-- "always" rows for the same (account, product) would be allowed.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_customer_prices_unique_idx
  ON public.commercial_customer_prices
    (account_id, product_id, COALESCE(effective_from, DATE '1900-01-01'));

-- Fast resolution lookup — account first because Tomco's price list
-- is the common query shape.
CREATE INDEX IF NOT EXISTS commercial_customer_prices_lookup_idx
  ON public.commercial_customer_prices (account_id, product_id);

DROP TRIGGER IF EXISTS commercial_customer_prices_touch_updated_at_trigger
  ON public.commercial_customer_prices;
CREATE TRIGGER commercial_customer_prices_touch_updated_at_trigger
  BEFORE UPDATE ON public.commercial_customer_prices
  FOR EACH ROW
  EXECUTE FUNCTION public.commercial_products_touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 3. Add product_id to commercial_invoice_line_items
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.commercial_invoice_line_items
  ADD COLUMN IF NOT EXISTS product_id UUID
    REFERENCES public.commercial_products(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.commercial_invoice_line_items.product_id IS
  'Optional FK to the product catalog. Set when the user picks from
   ProductPicker; NULL for legacy free-text line items. Historical
   invoices are never rewritten by catalog updates — the snapshotted
   unit_price_cents on the line item is the source of truth. Migration
   050, 2026-07-13.';

-- Index for margin reports (group by product across invoices).
CREATE INDEX IF NOT EXISTS commercial_invoice_line_items_product_idx
  ON public.commercial_invoice_line_items (product_id)
  WHERE product_id IS NOT NULL;
