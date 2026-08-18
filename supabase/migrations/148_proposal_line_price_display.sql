-- 148 — Proposal line-item price display + per-line price override
-- Brendan 2026-08-17 (proposal feedback round 1):
--
--  1. "when you click show line item price on the product it doesn't show up,
--      only when you click show line item at the bottom it does show up."
--     The per-line checkbox only suppressed a cell inside the ITEMIZED TABLE,
--     which the default customer proposal never renders — so ticking it did
--     nothing. It now prints that line's price inline in the normal bulleted
--     customer render.
--
--     Because the column defaulted to TRUE, honouring it as-is would have
--     suddenly printed a price on every line of every existing proposal. So
--     existing rows are backfilled to FALSE and the default flips to FALSE:
--     the checkbox becomes a deliberate opt-in, and no proposal on file
--     changes how it prints.
--
--  2. "we should be able to override a line item price as well. So we can have
--      the accurate qty if we decide to discount or charge more."
--     `line_total_override_cents` replaces qty × unit_price for that line only,
--     leaving the quantity honest on the page. NULL = compute normally.

ALTER TABLE commercial_proposal_line_items
  ADD COLUMN IF NOT EXISTS line_total_override_cents integer;

COMMENT ON COLUMN commercial_proposal_line_items.line_total_override_cents IS
  'Overrides qty x unit_price for this line. NULL = computed. Lets an estimator discount or uplift a line while keeping the real quantity on the proposal.';

-- Preserve how every proposal on file prints today.
UPDATE commercial_proposal_line_items
   SET show_price = false
 WHERE show_price IS TRUE;

ALTER TABLE commercial_proposal_line_items
  ALTER COLUMN show_price SET DEFAULT false;

COMMENT ON COLUMN commercial_proposal_line_items.show_price IS
  'Opt-in: print THIS line''s price on the customer proposal (just the money — not qty or unit price). Default false; the customer copy otherwise shows a single TOTAL.';
