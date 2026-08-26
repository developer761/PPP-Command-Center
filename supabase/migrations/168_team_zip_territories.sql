-- 168 · Zip codes belong to a team. (Karan, 2026-08-26; Brendan, 2026-08-25)
--
-- Brendan: "the location of the job will determine the team who will execute
-- the project."
-- Karan:   "when making a team we need to be able to add zipcodes that belong
--           to that team basically, and it should autofill for opps when that
--           zipcode is put in, but we should still be able to change it."
--
-- SAME SHAPE AS THE TAX JURISDICTIONS, on purpose. `commercial_tax_jurisdictions
-- .zip_prefixes` already solves "which thing owns this address", it is matched
-- by longest prefix, and Katie already maintains it. A second, differently-
-- behaving zip mechanism would mean two mental models for one question.
--
-- PREFIXES, not whole zips. "117" covers Suffolk without typing 200 entries;
-- "11722" beats it for one town that belongs to a different crew. Longest match
-- wins, exactly as tax does.
--
-- OVERLAP IS ALLOWED AND DELIBERATE. Salesforce permits only one owner per zip
-- code, and Mac named that as the blocker that breaks on new hires — a trainee
-- has to shadow zips that already belong to someone. Two teams may claim the
-- same prefix here; the longest match wins and a tie resolves to the older team
-- so the answer is stable rather than random. The UI warns rather than refuses:
-- an overlap is usually intentional, and refusing it would rebuild the exact
-- limitation they are trying to escape.
--
-- THE AUTOFILL NEVER OVERWRITES A CHOICE. It fills the team only when a deal
-- has none. Someone who deliberately assigned a crew must not have it changed
-- underneath them because an address was corrected — which is why this is a
-- default, not a rule.

ALTER TABLE public.commercial_teams
  ADD COLUMN IF NOT EXISTS zip_prefixes text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.commercial_teams.zip_prefixes IS
  'Zip prefixes this team covers, e.g. {117,11722}. Longest match wins, ties go to the older team. Overlap between teams is allowed on purpose (new hires shadow existing territory). Used to DEFAULT a deal''s team from its site zip — never to override one already set.';

-- The lookup runs on every deal create that carries a zip, so it should not be
-- a sequential scan once there are more than a handful of teams.
CREATE INDEX IF NOT EXISTS commercial_teams_zip_prefixes_idx
  ON public.commercial_teams USING GIN (zip_prefixes);
