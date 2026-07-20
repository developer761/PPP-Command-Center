-- ────────────────────────────────────────────────────────────────────
-- Migration 063 — Labor line-item flag on commercial_proposal_line_items
-- ────────────────────────────────────────────────────────────────────
-- Karan 2026-07-19: Katie's ask — "add a row to add labor as well
-- that also reflects on the proposal itself just incase they want to
-- put labor cost, add hours ect or something". Rather than a separate
-- `commercial_proposal_labor` table (over-engineered), we add a bool
-- flag to the existing line-item table. Labor rows:
--   * qty = hours (labeled "Hours" in the UI)
--   * unit = "hour" (defaults on new labor rows)
--   * unit_price_cents = hourly rate
--   * unit_price_cents × qty = row total (same math as inclusions)
--   * Roll into TOTAL exactly like inclusions (Alex sees ONE grand
--     total on the customer PDF — matches Tomco convention).
--
-- On the PDF, labor rows render under a "**Labor:**" bold-lead line
-- with each labor row as an indented sub-bullet showing hours × rate.
-- If a labor row has no dedicated description, the row's description
-- IS the labor line ("Skilled painters — prep + prime").
--
-- Idempotent (IF NOT EXISTS + WHERE guard on backfill), safe to re-run.

ALTER TABLE public.commercial_proposal_line_items
  ADD COLUMN IF NOT EXISTS is_labor BOOLEAN NOT NULL DEFAULT false;

-- Partial index on labor rows only — most proposals have zero labor
-- rows, keeps the full-table scan cheap for the count(*) rollup queries.
CREATE INDEX IF NOT EXISTS commercial_proposal_line_items_labor_idx
  ON public.commercial_proposal_line_items (proposal_id)
  WHERE is_labor = true;
