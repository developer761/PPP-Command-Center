-- The state a person works in, so the vendor list can be filtered to it.
--
-- Katie, 2026-10-02, overruling the first design: "I think this is
-- overcomplicating things. We don't need to sort the vendors based on location
-- relative to the job. We just need to filter the vendors based on location of
-- the team. The guys have relationships with specific stores and will order
-- from a further store because they use that store all the time, they carry
-- specific items, or maybe they're close to where they live, etc. It's not
-- always based on the location of the job."
--
-- She is right, and the first version was wrong for a reason worth recording:
-- it optimised for where the paint is going rather than for who is buying it.
-- A crew's vendor list is a set of relationships, not a geography problem.
--
-- It also removes the objection that blocked filtering a day ago. Hiding was
-- unsafe while three vendors had no state; Katie settled all three in the same
-- message (Paints by George is NY; Eco Wall Coatings and Sunbelt Rentals stay
-- inactive and are never emailed an order), so every ACTIVE vendor now carries
-- a state and a filter can no longer make one disappear.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS state TEXT;

COMMENT ON COLUMN public.profiles.state IS
  'Two-letter state this person works in, e.g. NY / NJ / FL. Filters the vendor picker to that state. NULL = unset, and an unset person sees every vendor rather than none.';
