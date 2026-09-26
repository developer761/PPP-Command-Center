-- A40's other half: the bot sets its own reminder and comes back.
--
-- Spec: "The bot re-opens the thread itself, at the time the customer named,
-- in the same thread and with full context." And the line that says why this
-- deserves care: "What has never once happened is the bot coming back."
--
-- The reminder IS the scheduled-action row. No column on the conversation,
-- because a second place to store "when we come back" is a second thing that
-- can disagree with the queue that actually fires — and the queue is the one
-- that decides.
--
-- ── THE CONSTRAINT NAME, READ NOT GUESSED ──────────────────────────────
--
-- sms_scheduled_actions_action_chk. Note the _chk. 20260926120000 guessed
-- _check, so its DROP matched nothing, its ADD created a second constraint
-- alongside the original, and every stall_followup insert failed 23514 while
-- the sweep reported "queued: 0" — indistinguishable from a healthy idle
-- sweep. 20260926180000 corrected it. This migration takes the name from
-- that file rather than from convention.

ALTER TABLE public.sms_scheduled_actions
  DROP CONSTRAINT IF EXISTS sms_scheduled_actions_action_chk;

ALTER TABLE public.sms_scheduled_actions
  ADD CONSTRAINT sms_scheduled_actions_action_chk
  CHECK (action IN (
    'send_step', 'agent_turn', 'send_reply',
    'followup_check', 'close_stale',
    'stall_followup',
    'park_reopen'
  ));

-- ONE REMINDER PER CONVERSATION.
--
-- A customer can park twice — "after the 15th", then on the 15th "actually
-- make it the 20th". The second park must REPLACE the first, not stack on
-- it, or the bot comes back twice and the second time reads as a bot that
-- forgot it had already asked. The application cancels the old row before
-- writing a new one; this index is what makes that a guarantee rather than
-- an intention.
--
-- Partial on state so a cancelled reminder does not block a re-park, which is
-- exactly how the second park is written.
CREATE UNIQUE INDEX IF NOT EXISTS sms_scheduled_actions_park_reopen_uniq
  ON public.sms_scheduled_actions (conversation_id)
  WHERE action = 'park_reopen' AND state <> 'cancelled';

COMMENT ON CONSTRAINT sms_scheduled_actions_action_chk ON public.sms_scheduled_actions IS
  'Which kinds of scheduled action exist. stall_followup is A44''s cadence; '
  'park_reopen is A40''s reminder. NOTE THE NAME: _chk, not _check — a '
  'migration that drops the wrong one silently leaves the old constraint in '
  'force beside the new one, and every insert fails 23514 while the sweep '
  'reports a clean run.';
