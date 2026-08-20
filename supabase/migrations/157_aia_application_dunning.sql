-- 157 · Past-due reminders for AIA payment applications.
--
-- Invoice dunning has existed since migration 079. A job billed through
-- G702/G703 raises NO invoice row, so a certified payment application could sit
-- ninety days past due and chase nobody — on the ledger that carries Tomco's
-- largest receivables.
--
-- Same dedup contract as `commercial_invoices.last_dunning_at`: the marker
-- lives on the row being chased, so the GC can't be emailed more than once per
-- ~7 days regardless of internal state, and the claim is written BEFORE the
-- send so a failed marker skips this run rather than risking a double-send.
--
-- Nothing derived is stored. Whether an application is overdue is still
-- computed from `frozen_at`/`period_to` through the one shared ladder
-- (`aiaDueAtFrom`), so the reminder can never disagree with the AR-aging
-- report, the receivables list, or the dashboard about what is late.

ALTER TABLE public.commercial_aia_applications
  ADD COLUMN IF NOT EXISTS last_dunning_at TIMESTAMPTZ;

COMMENT ON COLUMN public.commercial_aia_applications.last_dunning_at IS
  'When the GC was last emailed a past-due reminder for this application. Dedup marker for the daily dunning cron (mirrors commercial_invoices.last_dunning_at).';

-- The cron reads this per candidate application; the set is small, but the
-- partial index keeps it free as the application table grows.
CREATE INDEX IF NOT EXISTS commercial_aia_applications_dunning_idx
  ON public.commercial_aia_applications (opportunity_id, last_dunning_at)
  WHERE deleted_at IS NULL AND status = 'submitted';

-- ── The matching custom-alert trigger ───────────────────────────────────────
--
-- Migration 075 pinned the allowed trigger keys with a CHECK. `invoice_overdue`
-- has been offered since; its AIA twin could not be, so a rule like "tell the
-- team when anything is 30 days late" silently covered only half the money.
ALTER TABLE public.commercial_notification_rules
  DROP CONSTRAINT IF EXISTS commercial_notification_rules_trigger_check;

ALTER TABLE public.commercial_notification_rules
  ADD CONSTRAINT commercial_notification_rules_trigger_check
  CHECK (trigger IN (
    'invoice_overdue',
    'aia_overdue',        -- NEW: a payment application N+ days past due
    'invoice_due_soon',
    'invoice_paid',
    'proposal_idle',
    'followup_due',
    'opp_no_activity',
    'deal_won',
    'deal_lost'
  ));
