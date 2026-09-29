-- Online invoice payments through Stripe.
--
-- Today every invoice carries ONE static Stripe Payment Link and the customer
-- types the amount. WO 00313399 (2026-09-23) is the failure in one record:
-- the customer typed the credit-card amount ($4,665.08), paid with a method
-- that carries no fee, and PPP wrote a $135.88 Customer_Refund to send the
-- difference back.
--
-- The replacement: the invoice links to /pay/<token>. That page reads the
-- Work Order's Payment_Term__c rows and balance LIVE from Salesforce, and each
-- button creates a Stripe Checkout Session for a server-computed amount with
-- the payment method locked (card = +3%, ACH = no fee). The customer never
-- types a number.
--
-- Salesforce stays the source of truth for money. These tables are workflow
-- state only: which link belongs to which Work Order, which checkouts were
-- opened, what Stripe told us, and what we wrote (or WOULD have written) back
-- to Salesforce.

-- One row per Work Order that has an online-payment link. The token is the
-- only thing in the URL — never the WO number, which is sequential and would
-- let anyone walk other customers' balances.
CREATE TABLE IF NOT EXISTS public.payment_links (
  token              TEXT PRIMARY KEY,
  work_order_id      TEXT NOT NULL,
  work_order_number  TEXT NOT NULL,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set to switch a link off (WO cancelled, link leaked). The page then tells
  -- the customer to call the office instead of offering to take money.
  revoked_at         TIMESTAMPTZ
);

-- One live link per Work Order. Re-issuing returns the existing token so a
-- link already printed on an invoice keeps working.
CREATE UNIQUE INDEX IF NOT EXISTS payment_links_one_live_per_wo
  ON public.payment_links (work_order_id)
  WHERE revoked_at IS NULL;

-- One row per Stripe Checkout Session we create.
CREATE TABLE IF NOT EXISTS public.stripe_payments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_session_id    TEXT NOT NULL UNIQUE,
  token                  TEXT NOT NULL REFERENCES public.payment_links(token),
  work_order_id          TEXT NOT NULL,
  work_order_number      TEXT NOT NULL,
  -- A Payment_Term__c Id, or 'balance' for "pay the whole remaining balance".
  milestone_key          TEXT NOT NULL,
  -- Human label at the time of checkout: 'Deposit', 'Progress', 'Final',
  -- 'Full balance'. Stored so the history reads right even if the term is
  -- later renamed or deleted in Salesforce.
  milestone_label        TEXT NOT NULL,
  method                 TEXT NOT NULL CHECK (method IN ('card','ach')),
  -- Integer cents throughout. base = what comes off the balance; fee = the 3%
  -- card service fee (0 for ACH); total = what Stripe charges.
  base_cents             INTEGER NOT NULL CHECK (base_cents > 0),
  fee_cents              INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  total_cents            INTEGER NOT NULL CHECK (total_cents = base_cents + fee_cents),
  status                 TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','processing','succeeded','failed','expired','refunded')),
  livemode               BOOLEAN NOT NULL DEFAULT false,
  payment_intent_id      TEXT,
  checkout_url           TEXT,
  customer_email         TEXT,
  -- What reached Salesforce. 'dry_run' = the Transaction__c payload was built
  -- and stored but deliberately NOT sent (test mode, or write-back not yet
  -- switched on). The payload is kept either way so a person can check it.
  sf_writeback_status    TEXT
    CHECK (sf_writeback_status IN ('dry_run','written','failed')),
  sf_transaction_id      TEXT,
  sf_payload             JSONB,
  sf_writeback_detail    TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at                TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS stripe_payments_token_idx
  ON public.stripe_payments (token, created_at DESC);

-- Stripe retries webhooks and can deliver the same event more than once. The
-- event id is the idempotency key: a second delivery finds its row here and
-- does nothing, so one payment can never become two Salesforce transactions.
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id      TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  livemode      BOOLEAN NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'ok', or the error text if handling threw. Only 'ok' short-circuits a
  -- redelivery; an errored or unfinished event is handled again on retry.
  outcome       TEXT
);

-- Service-role only. None of this is readable with the publishable key.
ALTER TABLE public.payment_links         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_payments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.stripe_payments IS
  'One row per Stripe Checkout Session opened from /pay/<token>. Amounts in cents. sf_writeback_status=dry_run means the Salesforce Transaction__c was built but not sent. See lib/payments/.';
