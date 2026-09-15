-- Emily answers 30 seconds to a minute and a half after the customer's text.
--
-- Karan, 2026-09-15. Two changes, both needed for that sentence to be true.
--
-- 1. THE DELAY TIMES DELIVERY, NOT THE START OF THE TURN.
--    An agent turn used to be delayed, then write its reply, then send. The
--    writing and the wait for the next tick came on top of the delay. Now the
--    turn starts about 15 seconds after the text, writes the reply, and holds
--    it as a 'send_reply' action due at a moment drawn from the range,
--    counted from the customer's message. These columns carry the held reply.
--
--    answers_message_id is how a stale reply is caught: if the customer has
--    texted again by the time the held reply is due, it answers the wrong
--    message, so it is dropped and the newer message's own turn answers
--    everything.
--
-- 2. EVERY WORKSPACE DEFAULTS TO 30-90 SECONDS.
--    Only rows still at 0/0, the old "off" default, are moved; a range somebody
--    set by hand is left alone. It still applies only where Emily sends on her
--    own (autosend); a reply a person approves goes when they approve it.
--
-- Safe to re-run.

ALTER TABLE public.sms_scheduled_actions
  ADD COLUMN IF NOT EXISTS reply_due_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_body         TEXT,
  ADD COLUMN IF NOT EXISTS reply_intent       TEXT,
  ADD COLUMN IF NOT EXISTS reply_confidence   NUMERIC,
  ADD COLUMN IF NOT EXISTS answers_message_id UUID
    REFERENCES public.sms_messages(id) ON DELETE CASCADE;

-- The action list gains send_reply. The original CHECK was unnamed, so find
-- it by what it checks rather than guessing its generated name.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.sms_scheduled_actions'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%action%agent_turn%'
  LOOP
    EXECUTE format('ALTER TABLE public.sms_scheduled_actions DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE public.sms_scheduled_actions
  ADD CONSTRAINT sms_scheduled_actions_action_chk
  CHECK (action IN ('send_step','agent_turn','send_reply','followup_check','close_stale'));

-- A held reply without its text or its moment is a send with nothing to say.
ALTER TABLE public.sms_scheduled_actions DROP CONSTRAINT IF EXISTS sms_scheduled_actions_send_reply_chk;
ALTER TABLE public.sms_scheduled_actions
  ADD CONSTRAINT sms_scheduled_actions_send_reply_chk
  CHECK (action <> 'send_reply' OR (reply_body IS NOT NULL AND reply_due_at IS NOT NULL AND answers_message_id IS NOT NULL));

COMMENT ON COLUMN public.sms_scheduled_actions.reply_due_at IS
  'When the reply should reach the customer, counted from their text. On agent_turn rows it is carried to the held send_reply. Migration 20260915135711.';
COMMENT ON COLUMN public.sms_scheduled_actions.answers_message_id IS
  'The inbound message a held reply answers. If a newer inbound exists at send time the reply is stale and is dropped.';

ALTER TABLE public.sms_sub_accounts
  ALTER COLUMN reply_delay_min_seconds SET DEFAULT 30,
  ALTER COLUMN reply_delay_max_seconds SET DEFAULT 90;

UPDATE public.sms_sub_accounts
   SET reply_delay_min_seconds = 30, reply_delay_max_seconds = 90, updated_at = NOW()
 WHERE reply_delay_min_seconds = 0 AND reply_delay_max_seconds = 0;
