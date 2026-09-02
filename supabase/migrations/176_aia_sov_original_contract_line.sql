-- 176 · The schedule of values is ONE contract line, plus change orders.
--
-- Stephanie 2026-09-01: "The inclusions shouldn't show up line by line in the
-- schedule of values, especially if the total price was altered. When we bill,
-- Line 1 is the Original Contract which is the total of the approved proposal
-- items and the lines below line 1 are all the change orders. We don't provide
-- an item specific SOV unless the GC specifically requests it."
--
-- The seed built one G703 row per proposal inclusion. Two problems with that,
-- and the second is the one she led with:
--
--   · It publishes Tomco's internal breakdown to the GC on every application.
--     A schedule of values is a billing instrument, not a price list, and once
--     the GC has the per-item numbers every future negotiation starts there.
--
--   · When a final-price override is set — which is normal, it is how a bid
--     gets negotiated to a round number — the seed SCALED every line
--     proportionally to make the column foot to the contract sum. So the GC
--     received per-item values that are arithmetic artefacts: they match no
--     proposal, no conversation, and no invoice. "Especially if the total
--     price was altered" is exactly this.
--
-- Default false: one line reading "Original Contract". Set true per
-- application on the rare job where the GC asks for the breakdown, which is
-- how she described it — the exception, requested, not the default.
--
-- Per APPLICATION rather than per deal on purpose: a GC can ask for the detail
-- once, mid-job, without rewriting the schedule of every application already
-- sent.
ALTER TABLE commercial_aia_applications
  ADD COLUMN IF NOT EXISTS itemized_sov boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN commercial_aia_applications.itemized_sov IS
  'FALSE (default) = G703 line 1 is a single "Original Contract" line, change orders below it — how Tomco bills. TRUE = break the contract out per proposal inclusion, only when the GC specifically requests it (Stephanie 2026-09-01).';
