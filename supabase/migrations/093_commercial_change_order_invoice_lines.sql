-- 093 · Change orders billed as invoice LINE ITEMS (Phase 1A · tick model)
-- ─────────────────────────────────────────────────────────────────────────
-- Ticking an approved change order adds it to the deal's current invoice as its
-- own line (flat invoice) or milestone (milestone invoice). This migration:
--   1. tags a line item with its originating change order, so CO lines are
--      identifiable + can be removed/re-billed cleanly (mirrors the milestone
--      table, which already has change_order_id from migration 090);
--   2. lets a DEDUCT (credit) change order show as a NEGATIVE line/milestone —
--      Karan 2026: "my team will realize something's off by seeing that
--      negative." The relaxation is CONDITIONAL: only a CO-tagged row may go
--      negative; a normal manual line/milestone still can't (guards fat-finger).
--   3. The invoice's own `subtotal_cents >= 0` check is DELIBERATELY LEFT INTACT
--      — a bill can never total below $0. The app caps a too-large credit and
--      surfaces a heads-up instead of letting the invoice go negative.
--
-- Idempotent, plain statements (no DO/plpgsql — Supabase SQL editor safe).

-- 1. CO tag on line items (nullable; SET NULL if the CO row is ever hard-removed
--    — the app soft-deletes, so this is a safety net, not the normal path).
ALTER TABLE public.commercial_invoice_line_items
  ADD COLUMN IF NOT EXISTS change_order_id UUID
  REFERENCES public.commercial_change_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cili_change_order
  ON public.commercial_invoice_line_items(change_order_id)
  WHERE change_order_id IS NOT NULL;

-- 2a. Line items: allow a negative unit price ONLY for a CO line (deduct CO).
ALTER TABLE public.commercial_invoice_line_items
  DROP CONSTRAINT IF EXISTS commercial_invoice_line_items_unit_price_cents_check;
ALTER TABLE public.commercial_invoice_line_items
  ADD CONSTRAINT commercial_invoice_line_items_unit_price_cents_check
  CHECK (unit_price_cents >= 0 OR change_order_id IS NOT NULL);

-- 2b. Milestones: allow a negative amount ONLY for a CO milestone (deduct CO).
--     (commercial_invoice_milestones.change_order_id already exists — mig 090.)
ALTER TABLE public.commercial_invoice_milestones
  DROP CONSTRAINT IF EXISTS commercial_invoice_milestones_amount_cents_check;
ALTER TABLE public.commercial_invoice_milestones
  ADD CONSTRAINT commercial_invoice_milestones_amount_cents_check
  CHECK (amount_cents >= 0 OR change_order_id IS NOT NULL);

-- 3. One-CO-one-billing at the DB level. A change order may be billed on at
--    most ONE live line AND at most one live milestone — a partial UNIQUE index
--    is the atomic backstop behind the app's compare-and-swap claim, so a
--    double-click / two tabs can't attach the same CO twice.
--    (Line items are hard-deleted, so no deleted_at filter there. Milestones are
--     soft-deleted, so only live ones count.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_cili_change_order
  ON public.commercial_invoice_line_items(change_order_id)
  WHERE change_order_id IS NOT NULL;

DROP INDEX IF EXISTS public.idx_cim_change_order; -- non-unique (mig 090) → replace
CREATE UNIQUE INDEX IF NOT EXISTS uq_cim_change_order
  ON public.commercial_invoice_milestones(change_order_id)
  WHERE change_order_id IS NOT NULL AND deleted_at IS NULL;

-- 4. (No change to commercial_invoices.subtotal_cents >= 0 — invoices never go
--     negative; the app floors a credit at the invoice subtotal.)
