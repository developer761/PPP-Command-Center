-- 189_sf_user_links.sql
-- An explicit, admin-set link from a hub sign-in address to a Salesforce User.
--
-- WHY THIS EXISTS (Jason Ng, 2026-09-03)
-- Jason signs in with Google as jason.eng@precisionpaintingplus.net. In
-- Salesforce that exact address belongs to "Jason Eng-inactive", a deactivated
-- record. His live record is "Jason Ng" <jason.ng@precisionpaintingplus.com>.
-- The hub was right to refuse him: it found a user at his address and that user
-- is genuinely inactive.
--
-- No email rule can bridge this. The cross-domain lookup (Amy, 2026-08-31)
-- swaps .net/.com and already rescues 42 people whose local part matches across
-- domains. Jason's LOCAL PART differs — "jason.eng" vs "jason.ng" — so there is
-- nothing to swap.
--
-- The tempting fix is fuzzy matching: one edit apart, surely the same person.
-- That must not go in an auth path. "eng" vs "ng" is one character, and so are
-- plenty of genuinely different people; a string-similarity heuristic deciding
-- who reads whose pipeline is a data-leak waiting for its first collision. PPP
-- already has two distinct SF lineages here ("Jason Eng" AND "Jason Ng", each
-- with its own -inactive twin), which is exactly the ambiguity a heuristic
-- would paper over.
--
-- So the assertion is made by a human admin and recorded, with who made it and
-- why. Same shape as the cross-domain rule, but sourced from a person.
--
-- Run in Supabase SQL editor. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.sf_user_links (
  -- The address the person actually signs in with, lowercased.
  login_email   TEXT PRIMARY KEY,
  -- The Salesforce User Id their session should resolve to.
  sf_user_id    TEXT NOT NULL,
  -- Denormalized for the admin list, so it reads without an SF round-trip.
  sf_user_name  TEXT,
  sf_user_email TEXT,
  -- Who asserted this and on what basis. Not decoration: this row grants a
  -- person access to another record's data, so it has to be attributable.
  created_by    TEXT NOT NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sf_user_links_sf_user_id_idx ON public.sf_user_links (sf_user_id);

-- Service-role only. No user-facing policy at all: a row here decides identity,
-- so nothing reachable from the browser session may read or write it.
ALTER TABLE public.sf_user_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sf_user_links_no_client_access ON public.sf_user_links;

COMMENT ON TABLE public.sf_user_links IS
  'Admin-asserted login-email -> Salesforce User links, for people whose Google address does not match any active SF user (e.g. jason.eng@ signing in against the active jason.ng@ record). Consulted by lib/auth/sf-user-lookup.ts before the email query.';
