-- 158 · The warranty goes out when the GC asks for it, not on every close-out.
--
-- Katie's note is one line: "**Warranty** sent ONLY as requested."
--
-- The close-out send did the opposite. Marking a package "sent" rendered the
-- warranty letter and filed it against the deal, stamped "1-year warranty
-- letter sent", on every job — because `warranty_years` defaults to 1 and the
-- send checked only that it was above zero. Nobody had to ask.
--
-- That matters more than a paperwork rule. The letter carries Brendan's stored
-- signature, and it is a twelve-month guarantee to repair or replace at Tomco's
-- own expense. A warranty nobody requested is an obligation nobody had to give.
--
-- So issuing it becomes a deliberate act with its own timestamp, rather than a
-- side effect of a status change. `warranty_years` is untouched: the warranty
-- PERIOD is a fact about the job (it drives "warranty through" on the deal and
-- the close-out checklist) whether or not a letter was ever issued. Only the
-- letter is gated.
--
-- Nullable with no default — NULL means "never issued", which is the honest
-- state for every package that exists today. Backfilling a date would claim a
-- letter went out on a job where one may well have.

ALTER TABLE public.commercial_closeout_packages
  ADD COLUMN IF NOT EXISTS warranty_issued_at TIMESTAMPTZ;

COMMENT ON COLUMN public.commercial_closeout_packages.warranty_issued_at IS
  'When the warranty letter was issued to the GC, on request (Katie: "Warranty sent ONLY as requested"). NULL = never issued. Distinct from warranty_years, which is the term and applies regardless.';
