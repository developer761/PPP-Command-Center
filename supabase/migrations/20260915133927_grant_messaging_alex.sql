-- Connect Hub access for Alex.
--
-- Karan, 2026-09-15. Alex Zilberman, PPP's CEO, is already an admin on both
-- Command Centers; this adds the Connect Hub tile, the same way Kate and Katie
-- were given it in migration 187.
--
--   alex@precisionpaintingplus.net   Alex — CEO
--
-- Granted deliberately rather than inherited: this surface can text a
-- customer, so nobody arrives in it by holding a role. Only the .net account
-- exists; the .com spelling is listed because PPP is not consistent about the
-- domain, and matching an address that does not exist grants nothing.
--
-- To revoke: set has_messaging_access = FALSE for the same addresses.
-- Safe to re-run.

UPDATE public.profiles
   SET has_messaging_access = TRUE
 WHERE LOWER(email) IN (
   LOWER('alex@precisionpaintingplus.net'),
   LOWER('alex@precisionpaintingplus.com')
 );
