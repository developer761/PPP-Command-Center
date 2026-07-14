-- Phase F round-3 audit fix (Karan 2026-07-14).
--
-- The Tomco proposal format memory lists 10 canonical recurring
-- exclusions across 5 real 2026 proposals. Migration 054 seeded 9 of
-- them — the 10th ("Hours outside of normal business hours M-F") is
-- the after-hours variant of the standard "normal business hours"
-- exclusion, per project_tomco_proposal_format.md line 42:
--   "Work to be completed during normal business hours. / Hours
--    outside of normal business hours M-F"
--
-- The slash notation means Alex picks ONE of the two per proposal
-- depending on the job. Both need to live in the library.
--
-- Idempotent via NOT EXISTS guard — safe to re-paste, safe to run
-- before or after migration 054.

INSERT INTO commercial_exclusions (text, category, is_active)
SELECT
  'Hours outside of normal business hours M-F',
  'optional',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM commercial_exclusions
  WHERE lower(trim(text)) = lower(trim('Hours outside of normal business hours M-F'))
);
