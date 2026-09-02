-- 174 · WHEN the customer took a line, not just whether.
--
-- Stephanie 2026-09-01: "Approved alternates can't show up as change orders
-- unless approved AFTER the job is won. Many times the contract is issued with
-- the alternate and it is part of the original contract sum. If the alternate
-- shows up as a change order when billing, the GC is going to get confused and
-- possibly kick it back because they never approved a CO even though the total
-- contract amount is correct."
--
-- The mechanism she is describing is real, and it is the OPPOSITE of what it
-- looks like. Nothing in this codebase turns an alternate into a change order.
-- What happens is that `total_cents` — the single contract number the AIA
-- ladder, invoicing and every KPI consume — sums only `is_alternate = false`,
-- unconditionally. So an alternate the GC awarded as part of the contract is
-- silently dropped from the contract sum, G702 line 1 comes out short by
-- exactly that amount, and the only way left to bill it is for a person to
-- raise a change order. The GC then receives a CO for work they never approved
-- as a CO — while the total is correct, which is precisely why it confuses.
--
-- Fixing that needs the one thing migration 167 did not record: WHEN. Her rule
-- turns on it —
--   accepted at or before the win  → part of the original contract sum
--   accepted after the win         → a genuine change order
-- — and a bare boolean cannot tell those apart.
--
-- Nullable, and null on every existing row: 16 alternates exist today and all
-- of them are "not answered", so there is no history to backfill and nothing
-- to guess at. A row that says true with no timestamp predates this column;
-- the reader treats that as "at the win", which is the common case and the
-- safe one — it puts the money in the contract rather than inventing a CO.
ALTER TABLE commercial_proposal_line_items
  ADD COLUMN IF NOT EXISTS customer_approved_at timestamptz;

COMMENT ON COLUMN commercial_proposal_line_items.customer_approved_at IS
  'When customer_approved was last set. Decides whether an accepted ALTERNATE belongs in the original contract sum (at/before the deal was won) or is a genuine change order (after). NULL with customer_approved = true means it predates this column — read as "at the win".';
