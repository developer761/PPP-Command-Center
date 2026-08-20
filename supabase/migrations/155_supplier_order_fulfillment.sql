-- 155 — fulfilment entries survive the round trip back to the order.
--
-- Kate round-4 #33: "Anything typed on the Fulfillment step — instructions,
-- required-by, pickup location, address, phone — is gone if you go back to
-- change something on the order and return."
--
-- She also named the constraint, correctly: "the one-way flow you built for
-- Round 3 #18 is what stops an address edit from wiping typed quantities, and
-- we don't want that back."
--
-- So this is deliberately a SECOND column rather than more keys inside
-- `payload`. The separation is then structural, not a convention someone has to
-- remember:
--
--   /api/admin/supplier-order/build        writes `payload` only
--   /api/admin/supplier-order/fulfillment  writes `fulfillment` only
--
-- Neither endpoint can clobber the other's data even by accident, which is the
-- property that made round 3 #22/#23/#20 possible in the first place — those
-- were all one screen writing over another's state.
alter table public.supplier_order_builds
  add column if not exists fulfillment jsonb;

comment on column public.supplier_order_builds.fulfillment is
  'Fulfilment-step entries: { method, pickupLocation, deliveryAddr, useCustomAddress, instructions, requiredBy, contactPhone }. Written ONLY by the fulfilment route; the order builder never touches it, and it never touches the order payload. Kate round-4 #33.';
