-- 164 · Qualifications are their own section. (Stephanie, 2026-08-17)
--
-- HER NOTE: "Qualifications should be its own section after exclusions, not
-- grouped in with alternates."
--
-- On a Tomco proposal these are two different statements:
--   Exclusions     — work we are NOT doing ("Excludes drywall repair").
--   Qualifications — conditions our price DEPENDS ON ("Price assumes one
--                    mobilisation", "Assumes clear and unobstructed access").
--
-- The platform had one list and printed one "Exclusions:" heading, so a
-- qualification either read as something we refuse to do, or got typed into the
-- alternate notes to keep it out of that list — which is how it ended up
-- "grouped in with alternates" on the page.
--
-- `kind` on the LIBRARY entry rather than per-proposal: a line is inherently one
-- or the other regardless of which job it lands on, and the library is where
-- someone maintains that. Defaults to 'exclusion' so every existing row keeps
-- printing exactly where it prints today.
--
-- TEXT + CHECK, not an enum, matching the `category` column beside it — the
-- taxonomy can grow from the UI without a schema change.

ALTER TABLE commercial_exclusions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'exclusion';

ALTER TABLE commercial_exclusions
  DROP CONSTRAINT IF EXISTS commercial_exclusions_kind_check;

ALTER TABLE commercial_exclusions
  ADD CONSTRAINT commercial_exclusions_kind_check
  CHECK (kind IN ('exclusion', 'qualification'));

COMMENT ON COLUMN commercial_exclusions.kind IS
  'exclusion = work we are not doing; qualification = a condition the price depends on. Drives which section of the proposal PDF the line prints under.';
