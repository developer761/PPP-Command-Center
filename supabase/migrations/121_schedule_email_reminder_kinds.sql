-- 121: widen commercial_schedule_email_log.kind for the two new crew reminders.
-- Karan 2026-08: crew now get a 1-DAY-before and 1-HOUR-before reminder on top of
-- the existing 10-min clock-in nudge — each an independent Resend scheduled send
-- carrying that crew member's personal clock-in/out magic link. Every reminder is
-- deduped per (employee, work_date, kind), so the two new kinds must be allowed.
--
-- The original kind CHECK was inline on the column (migration 113), auto-named
-- commercial_schedule_email_log_kind_check. Drop-if-exists then re-add the widened
-- list. Idempotent — re-running is safe. The app tolerates this being un-applied:
-- claiming a new kind just fails the insert, so that reminder is silently skipped
-- (the 10-min nudge + all other emails keep working) until this is applied.

alter table public.commercial_schedule_email_log
  drop constraint if exists commercial_schedule_email_log_kind_check;

alter table public.commercial_schedule_email_log
  add constraint commercial_schedule_email_log_kind_check
  check (kind in ('day_of','clock_reminder','weekly','reminder_1day','reminder_1hour'));
