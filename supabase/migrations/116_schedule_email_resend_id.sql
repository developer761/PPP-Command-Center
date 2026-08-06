-- 116 — store the Resend message id on scheduled clock-in nudges.
--
-- The 10-min-before clock-in reminder is queued with Resend's scheduled_at at
-- assignment-add time. When a shift's start time later changes, we must CANCEL
-- that specific scheduled send (so it doesn't fire at the old time) and queue a
-- fresh one. Cancelling requires the Resend message id, so persist it on the
-- claim row. Nullable: day_of / weekly sends and any accepted-without-id send
-- simply leave it null.

ALTER TABLE commercial_schedule_email_log
  ADD COLUMN IF NOT EXISTS resend_message_id text;
