-- 160 · Reimbursements — money somebody is owed back.
--
-- "Tomco Reimbursements This Week" is one of the thirteen reports in Alex's
-- Salesforce folder. In his data these appear as Payment In rows against "SHOP"
-- with a memo reading "Reimbursed for material purchased" — a memo, on a
-- payment, which is why the report can list them and nothing can ever tell you
-- what is still OWED.
--
-- The underlying event is unambiguous even where the bookkeeping isn't:
-- somebody paid for material out of their own pocket (or on the shop's
-- account), and the company owes them for it. That is a purchase with two extra
-- facts — who fronted the money, and whether they've been paid back.
--
-- So this is two columns on the purchase rather than a new table. A purchase
-- IS the receipt; splitting the reimbursement into its own record would mean
-- two rows for one tube of caulk, and the job cost would double-count the
-- moment anyone got it wrong.
--
--   reimburse_to   — who is owed. NULL = an ordinary company purchase.
--   reimbursed_at  — when they were paid back. NULL = still owed.
--
-- Deliberately NOT a boolean pair. "Owed" is the absence of a settlement date,
-- so there is no way to be flagged reimbursed with no date, or dated with the
-- flag off — the two-field version of the same fact always drifts.

ALTER TABLE public.commercial_project_purchases
  ADD COLUMN IF NOT EXISTS reimburse_to TEXT;

ALTER TABLE public.commercial_project_purchases
  ADD COLUMN IF NOT EXISTS reimbursed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.commercial_project_purchases.reimburse_to IS
  'Who fronted the money and is owed it back. NULL = an ordinary company purchase, not a reimbursement.';
COMMENT ON COLUMN public.commercial_project_purchases.reimbursed_at IS
  'When they were paid back. NULL with reimburse_to set = still owed.';

-- The outstanding list is the query this exists for.
CREATE INDEX IF NOT EXISTS commercial_purchases_owed_reimbursement_idx
  ON public.commercial_project_purchases (reimburse_to, purchased_at)
  WHERE deleted_at IS NULL AND reimburse_to IS NOT NULL AND reimbursed_at IS NULL;
