-- Migration 060 — Phase F.6 Product Variations + Line-Item Phases.
--
-- Karan 2026-07-19: Katie's proposal notes require two schema shifts:
--   1. Product library needs parent → variation grouping so "HM Frame
--      & Wood Door" is one browsable item with two prep options
--      (Seal & Poly $175, Stain/Seal/Poly $225) instead of two
--      unrelated SKUs. Also needs an Interior/Exterior facet
--      separate from the paint/sundry/labor category axis.
--   2. Proposal line items need a phase label so the PDF can group
--      scope items under "Phase 1", "Phase 2", "Base Contract", etc.
--
-- Additive-only. Every existing row keeps working — new columns are
-- nullable, defaults are backward-compatible. Renames `notes` →
-- `description` on products via ADD-then-backfill-then-DROP so
-- inline queries against the old column name (if any) surface fast.
--
-- Idempotent + rerun-safe.

-- ────────────────────────────────────────────────────────────────────
-- 1. commercial_products: parent_product_id + variation_label + surface_area + description
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.commercial_products
  ADD COLUMN IF NOT EXISTS parent_product_id UUID
    REFERENCES public.commercial_products(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.commercial_products.parent_product_id IS
  'F.6: self-FK. Non-null = this row is a variation of the referenced
   parent product. Parent rows are catalog browse headers only — they
   should NOT be picked directly on a proposal (server-side reject via
   canSellProduct in lib/commercial/products/db.ts). ON DELETE CASCADE
   so soft-deleting a parent nukes its variations too. Migration 060.';

ALTER TABLE public.commercial_products
  ADD COLUMN IF NOT EXISTS variation_label TEXT;

COMMENT ON COLUMN public.commercial_products.variation_label IS
  'F.6: short label shown after the parent name in the picker, e.g.
   "Seal & Poly" or "Stain, Seal & Poly". Required when
   parent_product_id is set; NULL otherwise. Application-enforced
   (checked in createProduct/updateProduct).';

ALTER TABLE public.commercial_products
  ADD COLUMN IF NOT EXISTS surface_area TEXT NOT NULL DEFAULT 'other';

COMMENT ON COLUMN public.commercial_products.surface_area IS
  'F.6: one of interior / exterior / both / other. Separate facet
   from category so Alex can browse "Interior paint" or "Exterior
   labor" without collapsing the category axis. Application-enforced
   enum (kept as TEXT for admin extensibility, same pattern as
   category + unit).';

ALTER TABLE public.commercial_products
  ADD COLUMN IF NOT EXISTS description TEXT;

COMMENT ON COLUMN public.commercial_products.description IS
  'F.6: multi-line product description that flows into the proposal
   line item and PDF when picked. Backfilled from the legacy `notes`
   column on this migration. Alex-facing help text: "This shows up
   under the line item on the proposal PDF."';

-- One-time backfill: copy any existing `notes` text into `description`
-- so the rename is transparent to existing catalog entries. Only
-- copies where description is still NULL (idempotent — safe to rerun).
UPDATE public.commercial_products
   SET description = notes
 WHERE description IS NULL
   AND notes IS NOT NULL;

-- Index for picker queries: variations of a given parent, in name order.
CREATE INDEX IF NOT EXISTS commercial_products_parent_idx
  ON public.commercial_products (parent_product_id)
  WHERE deleted_at IS NULL AND parent_product_id IS NOT NULL;

-- Index for browse-by-surface list view.
CREATE INDEX IF NOT EXISTS commercial_products_surface_area_idx
  ON public.commercial_products (surface_area)
  WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────────────
-- 2. commercial_proposal_line_items: phase label
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.commercial_proposal_line_items
  ADD COLUMN IF NOT EXISTS phase TEXT;

COMMENT ON COLUMN public.commercial_proposal_line_items.phase IS
  'F.6: optional free-text phase label ("Phase 1", "Phase 2A", "Base
   contract"). NULL means ungrouped — the PDF renderer collects
   ungrouped items into a "General scope" section (or renders flat if
   NO items on the proposal have a phase set, preserving pre-F.6
   layout). Migration 060.';

-- Index for the (future) phase rollup queries. Cheap to maintain and
-- avoids seq scans if a proposal has hundreds of items across phases.
CREATE INDEX IF NOT EXISTS commercial_proposal_line_items_phase_idx
  ON public.commercial_proposal_line_items (proposal_id, phase)
  WHERE phase IS NOT NULL;
