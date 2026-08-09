-- 119: one absence row per (employee, day). commercial_absences (migration 112)
-- had no uniqueness, so a race / retried upsert could compound duplicate PTO rows
-- (audit round 7). A unique index enforces it at the DB and lets upsertAbsence use
-- ON CONFLICT. Idempotent via IF NOT EXISTS; assumes no existing dups (clean-start
-- module) — if the index build fails on a dup, dedupe first then re-run.

create unique index if not exists commercial_absences_emp_date_uq
  on public.commercial_absences (employee_id, work_date);
