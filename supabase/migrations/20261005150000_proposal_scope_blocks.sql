-- Free-text scope blocks on a proposal, each with its own price.
--
-- Stephanie 2026-10-05: "the drop down inclusion option is excellent for Kim
-- the estimator, [but] it is cumbersome and it doesn't really work when I am
-- asked to do proposals because most of the time there isn't a formal take off
-- or plans etc. It is just Brendan typing up an email and sending to me to put
-- into proposal format ... Can we add a text box (under the inclusions) that
-- has a price section in it but operates the same way the inclusions work
-- where I can add multiple custom inclusions?"
--
-- She has been doing it by hand already, and the database shows exactly how:
-- line items with no product, quantity 1, an entire multi-line scope pasted
-- into `description`, and the whole price in `unit_price_cents`. It renders
-- badly — the heading she types becomes the first bullet, and the price rides
-- one line of it — but the shape of what she needs is unmistakable.
--
-- Two columns rather than a new table. A scope block IS a line item: it has a
-- price, it belongs in the proposal total, and therefore it has to be the same
-- row the total, the sales tax, the AIA contract sum and the invoice all read.
-- A separate table would be a second source of money on the same document,
-- which is the defect this codebase keeps finding rather than one to add.
--
--   is_scope_block  marks the row so the builder and the PDF can treat it as a
--                   narrative block instead of a catalog line. Same pattern as
--                   is_labor (060) and is_internal (20260923190000).
--   block_title     the heading above the block — "Inspection Room:",
--                   "Exterior Doors:", "100 13th Ave, Ronkonkoma:" in her
--                   sample. Kept out of `description` so it can be set in bold
--                   rather than becoming the first bullet, which is the exact
--                   thing that looks wrong on the proposals she sent.

ALTER TABLE public.commercial_proposal_line_items
  ADD COLUMN IF NOT EXISTS is_scope_block BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.commercial_proposal_line_items
  ADD COLUMN IF NOT EXISTS block_title TEXT;

-- The PDF and the builder both ask "which rows on this proposal are blocks?"
-- on every render.
CREATE INDEX IF NOT EXISTS commercial_proposal_line_items_scope_block_idx
  ON public.commercial_proposal_line_items (proposal_id)
  WHERE is_scope_block;

COMMENT ON COLUMN public.commercial_proposal_line_items.is_scope_block IS
  'Free-text scope block with its own price (Stephanie 2026-10-05), rendered as a headed narrative section with its own Price / Sales Tax / TOTAL rather than as a catalog line.';
COMMENT ON COLUMN public.commercial_proposal_line_items.block_title IS
  'Heading printed above a scope block, e.g. "Inspection Room:". Separate from description so it prints bold instead of becoming the first bullet.';
