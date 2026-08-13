-- 143 — say what A, B and C actually mean.
--
-- Stephanie 2026-08-13: "Accounts > Rating system? Can we personalize these..."
--
-- Today an account shows a bare letter with a tooltip that repeats the letter
-- ("Rating: A"). Nobody outside the person who set it knows what B means, so
-- the field gets ignored — which is the real problem. It is not that the
-- letters are wrong; it is that they say nothing.
--
-- So the STORED VALUES stay A/B/C. That is deliberate:
--   * no data migration, so no account can be mis-graded by a rename
--   * the existing CHECK, the list filter, the sort and the CSV export all
--     keep working untouched
--   * a letter is a fine short code on a crowded row; it just needs a meaning
--     attached
--
-- What becomes editable is the MEANING — a label and a description per letter,
-- which then show everywhere the letter appears. That is what "personalize"
-- buys someone: Katie can decide that A means "Preferred - bid everything"
-- without anybody re-grading two hundred accounts.
--
-- Defaults below are a starting point, not a decision. They are written to be
-- obviously editable rather than authoritative, since nobody has told us what
-- Tomco's A/B/C actually mean.

CREATE TABLE IF NOT EXISTS public.commercial_account_rating_labels (
  code        TEXT PRIMARY KEY CHECK (code IN ('A', 'B', 'C')),
  label       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

INSERT INTO public.commercial_account_rating_labels (code, label, description) VALUES
  ('A', 'Preferred', 'Bid everything they send. Pays on time, runs clean jobs.'),
  ('B', 'Standard',  'Bid selectively — normal terms, nothing unusual either way.'),
  ('C', 'Caution',   'Bid carefully. Slow payment, difficult sites, or thin margins.')
ON CONFLICT (code) DO NOTHING;

COMMENT ON TABLE public.commercial_account_rating_labels IS
  'What A/B/C mean, editable in Settings. The account rating itself stays A/B/C so filters, sorts and exports are unaffected.';
