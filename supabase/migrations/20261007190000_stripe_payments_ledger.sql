-- The Payments tab: one row per online payment, base and fee kept apart.
--
-- Salesforce gets the BASE amount only (the Payment In); the 3% credit-card fee
-- never goes into it. Finance still needs the whole picture to decide things
-- like whether the fee covers what cards cost PPP — so the Command Center keeps
-- it, per payment, exportable to Excel:
--
--   base (what Salesforce got) · fee collected · total charged ·
--   what Stripe charged PPP to process it · when it cleared · which payout.
--
-- stripe_fee_cents and cleared_at come from the Stripe payout the payment
-- cleared in (its balance transaction), so they are filled at payout.paid —
-- the same moment the payment is booked in Salesforce. Null until then.

ALTER TABLE public.stripe_payments
  ADD COLUMN IF NOT EXISTS customer_name    TEXT,
  ADD COLUMN IF NOT EXISTS payout_id        TEXT,
  ADD COLUMN IF NOT EXISTS cleared_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_fee_cents INTEGER CHECK (stripe_fee_cents IS NULL OR stripe_fee_cents >= 0);

-- The tab lists money that moved: in flight, paid, or refunded.
CREATE INDEX IF NOT EXISTS stripe_payments_ledger_idx
  ON public.stripe_payments (paid_at DESC)
  WHERE status IN ('processing', 'succeeded', 'refunded');

COMMENT ON COLUMN public.stripe_payments.stripe_fee_cents IS
  'What Stripe charged PPP to process this payment (balance transaction fee), from the payout it cleared in. Compare with fee_cents (the 3% collected from the customer).';
