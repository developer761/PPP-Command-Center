-- One-off work orders
--
-- Karan 2026-09-17: "if it's a one-off work order it makes a job/opp
-- automatically with some information and tags it as one-off work order and has
-- like all the info."
--
-- WHY AN OPPORTUNITY AT ALL, when the work order is the real thing here.
--
-- Because in this schema the opportunity is what makes a job BILLABLE and
-- COUNTABLE, and a job without one is a dead end that looks fine:
--
--   · scheduling and hours key on `commercial_jobs.id`, so a standalone job
--     can be booked and worked normally;
--   · every money table keys on `opportunity_id` — and
--     `commercial_invoices.opportunity_id` is NOT NULL, so such a job can
--     NEVER be invoiced;
--   · the Costs tool is mounted on the opportunity page, so its materials and
--     labor payouts have nowhere to be entered;
--   · it therefore appears in no cost, margin, AR or profitability report.
--
-- `createJob` has always allowed `opportunity_id` to be null, and there are
-- zero such rows on the live book — so this is not a migration of existing
-- data, it is closing a trap before somebody falls into it.
--
-- WHAT THIS ADDS. One flag. The auto-created opportunity is an ordinary
-- opportunity in every other respect, which is the point — it flows through
-- costs, invoicing and every report without any of them learning a new shape.

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS is_one_off boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.commercial_opportunities.is_one_off IS
  'Created from a one-off work order rather than won through a bid. Marks the row for the pipeline filter and the job-header badge; changes no money behaviour.';

-- Partial index: one-offs are the small minority and are always queried as
-- "only the one-offs", never "only the normal ones".
CREATE INDEX IF NOT EXISTS idx_commercial_opportunities_one_off
  ON public.commercial_opportunities (is_one_off)
  WHERE is_one_off = true;
