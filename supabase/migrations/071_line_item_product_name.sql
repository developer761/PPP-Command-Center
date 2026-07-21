-- ────────────────────────────────────────────────────────────────────
-- Migration 071 — snapshot product_name on proposal line items
-- ────────────────────────────────────────────────────────────────────
-- Karan 2026-07-21: the proposal PDF should show the PRODUCT name AND the
-- description as distinct pieces (Product optional, Description below/next
-- to it). Until now the ProductPicker baked the product name INTO the
-- description as a markdown bold-lead ("**HM Frame (Seal & Poly):** ..."),
-- so the PDF effectively showed description-only.
--
-- This adds a snapshotted `product_name` column (like `unit_price_cents`,
-- captured at pick time so a later product rename/delete doesn't rewrite
-- historic proposals). New rows set it from the picker; the description
-- becomes the free-text detail only. Legacy rows keep product_name = NULL
-- and the PDF falls back to parsing the old bold-lead out of description.
--
-- Additive + idempotent. Nullable — no backfill needed (legacy rows use
-- the description-parse fallback path in the renderer).

ALTER TABLE public.commercial_proposal_line_items
  ADD COLUMN IF NOT EXISTS product_name TEXT;

COMMENT ON COLUMN public.commercial_proposal_line_items.product_name IS
  'Snapshotted product display name (e.g. "HM Frame & Wood Door (Seal & Poly)")
   captured from the ProductPicker at pick time. Renders as the bold lead on
   the proposal PDF, with description below it. NULL for free-text rows and
   legacy rows (renderer falls back to parsing a bold-lead from description).';
