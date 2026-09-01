-- Migration 181: the due-work queue.
--
-- Every future send lives here as a row with a run_at. ONE minute-ly cron
-- claims due rows with FOR UPDATE SKIP LOCKED and executes them — one cron
-- however many agents or campaigns exist, because a cron expression cannot
-- express "this conversation, 15 minutes after its own last message".
--
-- It also makes the system inspectable: you can SELECT what it is about to do
-- tomorrow, before it does it. Cron-driven logic cannot offer that.
--
-- THE BUG THIS TABLE EXISTS TO PREVENT
-- PPP's campaign fires messages on days 2, 3, 4 and 5. The exits come from the
-- agent's COMMAND End: states. If nothing cancels the remaining steps, a
-- customer who books on Monday is asked "still interested in a free estimate?"
-- on Friday. That is the most damaging thing this engine can do, so it is
-- enforced by a trigger here rather than by remembering to call something.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_scheduled_actions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES public.sms_conversations(id) ON DELETE CASCADE,
  campaign_step_id UUID REFERENCES public.sms_campaign_steps(id) ON DELETE SET NULL,

  action           TEXT NOT NULL CHECK (action IN ('send_step','agent_turn','followup_check','close_stale')),
  run_at           TIMESTAMPTZ NOT NULL,

  state            TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending','claimed','done','cancelled','failed')),
  -- Set when a worker claims the row, so a crashed worker's rows can be
  -- reclaimed after a timeout rather than being stuck forever.
  claimed_at       TIMESTAMPTZ,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  cancelled_reason TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The claim query: due, pending, oldest first.
CREATE INDEX IF NOT EXISTS sms_scheduled_actions_due_idx
  ON public.sms_scheduled_actions (run_at)
  WHERE state = 'pending';

-- Idempotency: one campaign step is scheduled at most once per conversation.
-- Without this, a retried trigger enqueues day 2 twice and the customer gets
-- the same message twice.
CREATE UNIQUE INDEX IF NOT EXISTS sms_scheduled_actions_step_once_idx
  ON public.sms_scheduled_actions (conversation_id, campaign_step_id)
  WHERE campaign_step_id IS NOT NULL AND state <> 'cancelled';

ALTER TABLE public.sms_scheduled_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_scheduled_actions_no_client ON public.sms_scheduled_actions;

-- ── The cancellation guarantee ──────────────────────────────────────────
-- When a conversation ends, every pending action for it is cancelled in the
-- same transaction. In the database rather than the application because the
-- application will eventually reach 'ended' by a path somebody forgot to wire
-- the cleanup into, and the failure is invisible until a customer is chased
-- three days after booking.
CREATE OR REPLACE FUNCTION public.sms_cancel_pending_on_end()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.state = 'ended' AND (OLD.state IS DISTINCT FROM 'ended') THEN
    UPDATE public.sms_scheduled_actions
       SET state = 'cancelled',
           cancelled_reason = 'conversation ended: ' || COALESCE(NEW.outcome, 'unknown'),
           updated_at = NOW()
     WHERE conversation_id = NEW.id
       AND state IN ('pending', 'claimed');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_cancel_pending_on_end_trg ON public.sms_conversations;
CREATE TRIGGER sms_cancel_pending_on_end_trg
  AFTER UPDATE OF state ON public.sms_conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.sms_cancel_pending_on_end();

COMMENT ON TABLE public.sms_scheduled_actions IS
  'Due-work queue. One minute-ly cron claims due rows FOR UPDATE SKIP LOCKED, however many agents exist. Also makes tomorrow''s sends inspectable before they happen. Migration 181.';
COMMENT ON FUNCTION public.sms_cancel_pending_on_end() IS
  'Cancels pending sends when a conversation ends, in the same transaction. Enforced in the database because the application will eventually reach ended by a path nobody wired cleanup into, and the symptom is a customer chased days after they booked.';
