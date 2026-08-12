-- 129: give close-out its own date, so it stops overwriting the win date.
--
-- `decided_at` means "the day this deal was decided" — won or lost. It is what
-- "Wins this month" counts and what the dashboard's win-rate denominator reads.
--
-- But it was stamped on entry to ANY terminal status, and `post_sale_closed` is
-- terminal. So finishing a job's close-out paperwork overwrote the day it was
-- won: a deal won in March and closed out in August silently became an August
-- win. `wasWonInPeriod` works around this by refusing to count closed jobs at
-- all, which trades a wrong month for a missing win.
--
-- Close-out gets its own column. `decided_at` then means one thing for the whole
-- life of a deal, and a closed job can be counted in the month it was actually
-- won.
--
-- NOT backfilled, on purpose. For an already-closed deal `decided_at` currently
-- holds the close-out date, so copying it here would make the row look repaired
-- while its win date is still wrong — and `wasWonInPeriod` keys off this column
-- being present to decide whether a row can be trusted. Legacy rows stay
-- excluded exactly as they are today; recovering their true win dates from the
-- status log is a separate reviewed step.
--
-- Safe to re-run.

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS closed_out_at DATE;
