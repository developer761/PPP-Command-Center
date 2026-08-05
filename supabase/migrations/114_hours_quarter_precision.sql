-- 114 . Widen hours columns so quarter-hours store exactly.
-- commercial_time_entries.actual_hours + commercial_assignments.scheduled_hours
-- were numeric(4,1): a 0.25/0.75 value (from Math.round(h*4)/4 / start-end diffs)
-- rounded to 0.3/0.8, a small upward payroll drift. numeric(4,2) holds quarter
-- hours exactly. Additive/widening — safe to run anytime, no code change needed.

alter table public.commercial_time_entries
  alter column actual_hours type numeric(4,2);

alter table public.commercial_assignments
  alter column scheduled_hours type numeric(4,2);
