-- 079_commercial_invoice_dunning.sql
-- 15-day past-due client reminder (Karan 2026-07-27; np-billing-workflow §6).
--
-- The daily cron emails the GC billing contact a reminder once an invoice is
-- 15+ days past due, then re-sends at most weekly. last_dunning_at is the
-- robust dedup marker (independent of whether an internal recipient exists), so
-- a client can never get more than one reminder per ~7 days.

ALTER TABLE public.commercial_invoices
  ADD COLUMN IF NOT EXISTS last_dunning_at TIMESTAMPTZ;
