-- 118: add 'almost_done' to the commercial_jobs.status vocabulary.
-- Karan 2026-08: the Field Ops calendar shows a work order's status next to the
-- crew; "Almost done" is a stage between in_progress and complete. The status
-- column was created with an inline CHECK in migration 112 (auto-named
-- commercial_jobs_status_check); swap it for the widened list.
--
-- Idempotent: drop-if-exists then add. Re-running is safe (the drop clears the
-- prior definition first). The app tolerates this being un-applied — until then,
-- setting a job to 'almost_done' returns a friendly error instead of crashing.

alter table public.commercial_jobs
  drop constraint if exists commercial_jobs_status_check;

alter table public.commercial_jobs
  add constraint commercial_jobs_status_check
  check (status in (
    'estimating','ready_to_schedule','scheduled',
    'in_progress','almost_done','complete','closed','on_hold'));
