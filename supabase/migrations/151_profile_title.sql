-- 151 — Job title on the user profile
--
-- Brendan 2026-08-17: "Phone number, title and email are not showing on pdf
-- for client." The estimator sign-off block renders name / title / phone /
-- email correctly — it just had nothing to render, because the proposal only
-- ever pre-filled `full_name` and `email` from the profile. Phone had a column
-- (migration 145) and was simply never read; title had no column at all.
--
-- So every proposal made the estimator retype their own title and phone, and a
-- proposal sent before they noticed went to the GC with no way to reach the
-- person who priced it.
--
-- Set once on the profile, prints on every proposal that person signs.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS title text;

COMMENT ON COLUMN profiles.title IS
  'Job title (e.g. "Lead Estimator"). Pre-fills the estimator sign-off block on proposals so it does not have to be retyped per proposal.';
