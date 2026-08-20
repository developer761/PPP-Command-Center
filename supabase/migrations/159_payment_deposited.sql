-- 159 · Has the money actually reached the bank?
--
-- Alex's Salesforce accounting folder is 13 reports, and the one he opens is
-- "Tomco Payments In by Month". It carries a **Deposited** checkbox on every
-- row, which is the column that makes the report an accounting document rather
-- than a list: recording a payment says a cheque arrived, ticking Deposited
-- says it cleared. The gap between the two is the money sitting in the office.
--
-- We had no equivalent, so a payment recorded here could never be reconciled
-- against a bank statement — you could tell Alex what was collected, never what
-- had landed.
--
-- A TIMESTAMP rather than a boolean. "Deposited" is a thing that happens on a
-- day, and the day is what you match a bank line to; a boolean would answer
-- "yes" and lose the only detail that makes the answer useful.
--
-- NULL = not deposited (or not tracked yet), which is the honest state for
-- every payment recorded before today. Deliberately NOT backfilled to
-- `paid_at`: claiming historic payments cleared on the day they arrived would
-- put a number in front of a bookkeeper that nobody verified.

ALTER TABLE public.commercial_invoice_payments
  ADD COLUMN IF NOT EXISTS deposited_at TIMESTAMPTZ;

COMMENT ON COLUMN public.commercial_invoice_payments.deposited_at IS
  'When this payment was confirmed deposited (bank reconciliation). NULL = received but not yet deposited. Mirrors the Deposited column on Alex''s Salesforce "Payments In by Month" report.';

-- The undeposited list is the one query this drives that isn't already covered
-- by an index on paid_at.
CREATE INDEX IF NOT EXISTS commercial_invoice_payments_undeposited_idx
  ON public.commercial_invoice_payments (paid_at)
  WHERE deposited_at IS NULL;
