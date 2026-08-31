-- Migration 175: Messaging platform access flag.
--
-- The Hatch replacement lands as a THIRD tile at the /choose-platform hub
-- picker, beside PPP Command Center and Commercial — not nested under either.
-- An admin who works in messaging all day should not be two clicks deep, and
-- conversations carry their own context in the row rather than the route.
--
-- Same shape migration 019 used for the other two flags:
--   Command Center default TRUE  — nobody loses access they already had.
--   New Platform   default FALSE — admin grants per user.
--   Messaging      default FALSE — same, and deliberately so. Messaging can
--                                  text a customer; it is not a surface anyone
--                                  should land in by accident.
--
-- Read by platformAccess() in lib/auth/profile.ts, which returns the list of
-- platforms a profile may open. Adding this column is what puts "messaging"
-- into that list.
--
-- Safe to re-run: IF NOT EXISTS-guarded throughout.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS has_messaging_access BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill is a no-op for existing rows (NOT NULL DEFAULT FALSE already filled
-- them), but stated explicitly so re-running is provably idempotent and the
-- intent is on the record: existing users get nothing until granted.
UPDATE public.profiles SET has_messaging_access = FALSE WHERE has_messaging_access IS NULL;

-- Widen the platform-access index to cover all three flags. The old two-column
-- partial index stays valid for its own queries; this one serves the picker's
-- "which platforms does this profile hold" lookup, which now reads three.
CREATE INDEX IF NOT EXISTS profiles_platform_access_v2_idx
  ON public.profiles (has_command_center_access, has_new_platform_access, has_messaging_access)
  WHERE has_command_center_access = TRUE
     OR has_new_platform_access = TRUE
     OR has_messaging_access = TRUE;

COMMENT ON COLUMN public.profiles.has_messaging_access IS
  'Grants the Messaging tile at /choose-platform (the Hatch replacement). Defaults FALSE — this surface can send SMS to customers, so it is granted deliberately, never inherited. Migration 175.';

-- Seed: the builder only, so the tile is reachable while it is being built.
-- Everyone else is granted deliberately once there is something to look at —
-- see the OPEN QUESTION in the build plan about who gets it at shadow-run.
--
-- This is the PPP-owned Google Workspace identity Karan actually signs in with.
-- The first cut targeted malhotrak038@gmail.com, which is the invoice identity
-- and has no profiles row — so it granted access to nobody and the tile stayed
-- invisible to the person building it. Both domains listed because PPP is not
-- consistent about .net vs .com.
UPDATE public.profiles
   SET has_messaging_access = TRUE
 WHERE LOWER(email) IN (
   LOWER('developer@precisionpaintingplus.net'),
   LOWER('developer@precisionpaintingplus.com')
 );
