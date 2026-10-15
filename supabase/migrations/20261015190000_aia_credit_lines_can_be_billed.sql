-- A deductive line on a G703 has to be billable, not just listable.
--
-- 🔴 THE CODE AND THE SCHEMA HAVE DISAGREED SINCE MIGRATION 128.
--
-- 128 dropped `scheduled_value_cents`'s `>= 0` CHECK so a credit change order
-- could appear on the schedule of values at all — its own note explains the
-- bug: one credit CO failed the CHECK, took the whole batch insert down, and a
-- best-effort try/catch swallowed it, leaving the operator a blank G703 and no
-- error. It did not touch the three COMPLETION columns, because the problem in
-- front of it was the insert.
--
-- `clampCompletionToSign` in lib/commercial/aia/db.ts was written afterwards
-- with the opposite assumption, and says why in as many words:
--
--     Completion follows the sign of the line: a normal line can't be billed
--     negative, a CREDIT line (a deductive change order) can only be billed
--     negative. Clamping everything at zero left a deduct row permanently at 0,
--     so the descoped work came off the contract sum but never off the amount
--     completed — and the job billed past 100%.
--
-- So the library deliberately produces negative completion figures for a credit
-- line, and these three constraints reject them. The result is that a credit
-- line can be listed but never billed: any attempt returns a raw Postgres
-- constraint error to whoever typed it. Found on 2026-10-15 while auditing a
-- change that made the path reachable from the UI.
--
-- Dropping them is the resolution the code already assumes. The sign rule is
-- not lost — `clampCompletionToSign` is the only writer, and it forces every
-- completion figure to match the sign of its scheduled value, so a normal line
-- still cannot be billed negative. The constraint was enforcing half of a rule
-- the application enforces in full.

ALTER TABLE public.commercial_aia_line_items
  DROP CONSTRAINT IF EXISTS commercial_aia_line_items_from_previous_cents_check;
ALTER TABLE public.commercial_aia_line_items
  DROP CONSTRAINT IF EXISTS commercial_aia_line_items_this_period_cents_check;
ALTER TABLE public.commercial_aia_line_items
  DROP CONSTRAINT IF EXISTS commercial_aia_line_items_materials_stored_cents_check;

COMMENT ON COLUMN public.commercial_aia_line_items.this_period_cents IS
  'Signed. Negative only on a credit line (negative scheduled value) — enforced by clampCompletionToSign, which is the only writer. See migration 20261015190000.';
