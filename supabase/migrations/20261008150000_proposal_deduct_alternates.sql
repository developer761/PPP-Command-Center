-- Deduct alternates: an alternate that comes OFF the price, not onto it.
--
-- Stephanie 2026-10-08: "I need a option for deduct alternates that subtract
-- from the total, not add. Do I just put in a negative number?"
--
-- No — and that is worth recording, because it is the obvious thing to try.
-- `createLineItem` and `updateLineItem` both refuse a negative unit price
-- ("Unit price must be zero or greater"), so there was no way to express this
-- at all. She would have typed -2500, been told the price was invalid, and had
-- no idea what the platform wanted instead.
--
-- A FLAG, NOT A NEGATIVE NUMBER.
--
-- The amount stays positive and this says which direction it runs. Letting
-- negative money into `unit_price_cents` would push a sign through every sum
-- that touches a line item — the proposal total, the G702 contract sum, the
-- invoice, the change-order columns that already split additions from
-- deductions — and each of those would have to be audited for it. The sign
-- belongs to the alternate's MEANING, so it is stored as meaning.
--
-- Only alternates use it. A deduct inclusion is just a smaller price.

ALTER TABLE public.commercial_proposal_line_items
  ADD COLUMN IF NOT EXISTS is_deduct BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.commercial_proposal_line_items.is_deduct IS
  'Alternate that SUBTRACTS from the contract when accepted (Stephanie 2026-10-08). Amount is stored positive; this carries the direction. Prints under "Deduct Alternate:" and books a negative change order on accept.';
