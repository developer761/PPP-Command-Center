-- 113 . R10.7 - Interactive Calendar + email cadence support.
-- Adds a scheduled END time to assignments (so a shift is a real range, not just
-- hours) and a per-send email log so the daily cron is idempotent (day-of and
-- clock-in-reminder emails never double-fire on a cron retry).
-- All statements kept short / multi-line so copy-paste never corrupts a line.

alter table public.commercial_assignments
  add column if not exists scheduled_end_time time;

create table if not exists public.commercial_schedule_email_log (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null
                references public.commercial_employees(id) on delete cascade,
  work_date   date not null,
  kind        text not null
                check (kind in ('day_of','clock_reminder','weekly')),
  sent_at     timestamptz not null default now(),
  unique (employee_id, work_date, kind)
);

create index if not exists commercial_schedule_email_log_emp_idx
  on public.commercial_schedule_email_log (employee_id, work_date);
