-- Migration 187: messaging access for Kate and Katie.
--
-- Karan, 2026-09-02. Both are already admins on the two Command Centers; this
-- adds the third tile.
--
--   k.sutton@precisionpaintingplus.net   Kate  — AI ops, owns the Hatch audit
--   katie@precisionpaintingplus.net      Katie — admin / IT / Salesforce owner
--
-- Granted deliberately rather than inherited, which is the whole point of the
-- flag: this surface can text a customer. Nobody arrives in it by having a
-- role. Kate needs it to review shadow-mode drafts against what Hatch actually
-- sent; Katie needs it for the AWS, Salesforce and cutover work.
--
-- Both domains listed because PPP is not consistent about .net vs .com — but
-- only the .net rows exist today, so the .com entries are inert until such an
-- account is created. Matching on an address that does not exist grants
-- nothing, which is the safe direction.
--
-- To revoke: set has_messaging_access = FALSE for the same addresses.
-- Safe to re-run.

UPDATE public.profiles
   SET has_messaging_access = TRUE
 WHERE LOWER(email) IN (
   LOWER('k.sutton@precisionpaintingplus.net'),
   LOWER('k.sutton@precisionpaintingplus.com'),
   LOWER('katie@precisionpaintingplus.net'),
   LOWER('katie@precisionpaintingplus.com'),
   LOWER('katie.batilla@precisionpaintingplus.net'),
   LOWER('katie.batilla@precisionpaintingplus.com'),
   LOWER('kbatilla@precisionpaintingplus.net'),
   LOWER('kbatilla@precisionpaintingplus.com')
 );
