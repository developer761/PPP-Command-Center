-- Card payments on our own page, so the 3% fee applies to CREDIT cards only.
--
-- The first version sent every payment through Stripe's hosted Checkout, which
-- fixes the amount before the customer types a card — so a debit card paid the
-- credit-card fee. PPP charges no fee on debit (the invoice says so), and today
-- relies on a Stripe add-on app to tell the two apart.
--
-- Card payments now run on /pay/<token>/card with Stripe's Payment Element: the
-- customer enters the card, the server reads its funding type (credit / debit /
-- prepaid / unknown) from a ConfirmationToken, and only then fixes the amount —
-- +3% for credit, nothing otherwise. Bank (ACH) payments stay on hosted
-- Checkout.
--
-- These payments have a PaymentIntent but no Checkout Session, so the session
-- id stops being required and the PaymentIntent id becomes the other key.

ALTER TABLE public.stripe_payments
  ALTER COLUMN checkout_session_id DROP NOT NULL;

-- Exactly one of the two ids identifies a row.
ALTER TABLE public.stripe_payments
  DROP CONSTRAINT IF EXISTS stripe_payments_has_an_id;
ALTER TABLE public.stripe_payments
  ADD CONSTRAINT stripe_payments_has_an_id
  CHECK (checkout_session_id IS NOT NULL OR payment_intent_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS stripe_payments_payment_intent_uidx
  ON public.stripe_payments (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

-- What Stripe said the card was when the fee was decided: 'credit', 'debit',
-- 'prepaid' or 'unknown'. Kept so a fee (or its absence) can be explained to a
-- customer who asks, and audited against the add-on it replaces.
ALTER TABLE public.stripe_payments
  ADD COLUMN IF NOT EXISTS card_funding TEXT;

COMMENT ON COLUMN public.stripe_payments.card_funding IS
  'Card funding type Stripe reported before the amount was fixed. Only credit carries the 3% fee; debit, prepaid and unknown do not.';
