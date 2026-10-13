-- Pay links: hardening from the pre-launch review (2026-10-08).
--
-- 1. WHICH SALESFORCE every link and payment belongs to.
--    Sandbox testing shares this Supabase project, and a sandbox's records keep
--    the SAME Ids as production. Without an org on the row, a sandbox link for
--    a Work Order was the production link for it (re-issuing returned it;
--    switching it off in the sandbox switched off the real one), and sandbox
--    payments counted as "already paid online" on the real customer's page.
--    Every query now filters by org.
--
-- 2. A 'booking' state, so exactly one process books a payment in Salesforce.
--    Two deliveries of the same payout (Stripe retries while the first is still
--    working through a big payout), or an admin pressing "Book now" mid-payout,
--    could both see "not booked" and both create a Transaction__c. Booking now
--    claims the row first (… WHERE sf_writeback_status IS NULL → 'booking'),
--    and only the claimer writes.

ALTER TABLE public.payment_links
  ADD COLUMN IF NOT EXISTS sf_org TEXT NOT NULL DEFAULT 'production'
    CHECK (sf_org IN ('production', 'sandbox'));

ALTER TABLE public.stripe_payments
  ADD COLUMN IF NOT EXISTS sf_org TEXT NOT NULL DEFAULT 'production'
    CHECK (sf_org IN ('production', 'sandbox'));

-- One live link per Work Order PER ORG.
DROP INDEX IF EXISTS public.payment_links_one_live_per_wo;
CREATE UNIQUE INDEX IF NOT EXISTS payment_links_one_live_per_wo_org
  ON public.payment_links (work_order_id, sf_org)
  WHERE revoked_at IS NULL;

ALTER TABLE public.stripe_payments
  DROP CONSTRAINT IF EXISTS stripe_payments_sf_writeback_status_check;
ALTER TABLE public.stripe_payments
  ADD CONSTRAINT stripe_payments_sf_writeback_status_check
  CHECK (sf_writeback_status IN ('booking', 'dry_run', 'written', 'failed'));

CREATE INDEX IF NOT EXISTS stripe_payments_wo_org_idx
  ON public.stripe_payments (work_order_id, sf_org);
