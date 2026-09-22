-- Speed-to-lead and the qualification funnel, actually recorded.
--
-- Both columns have existed since migration 193 and neither has ever been
-- written. The reports read them anyway, so:
--
--   * speed-to-lead — the headline number, the whole "we answer in minutes
--     where Hatch takes fifteen" argument — is null for every conversation and
--     renders as no data at all;
--   * the funnel reads qualification_stage = 0 for every row, so stage 1 shows
--     "0 reached, -100%" in orange, which reads as every single customer
--     dropping at the first question.
--
-- A dashboard that is confidently wrong is worse than one that is empty.

-- ── 1. first_outbound_at, filled by the database ──────────────────────────
--
-- A TRIGGER rather than code in the three send paths. There are three today —
-- the campaign step, the agent, and a person replying — and a fourth was added
-- this week. Any path that forgets the line reintroduces the bug silently,
-- whereas a row landing in sms_messages is the definition of having sent
-- something. The database is the only place all four meet.
--
-- Uses NEW.created_at rather than NOW() so a backfilled or replayed message
-- dates the conversation from when it was actually sent.
CREATE OR REPLACE FUNCTION public.sms_mark_first_outbound()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.direction = 'outbound' THEN
    UPDATE public.sms_conversations
       SET first_outbound_at = NEW.created_at
     WHERE id = NEW.conversation_id
       AND first_outbound_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_mark_first_outbound_trg ON public.sms_messages;
CREATE TRIGGER sms_mark_first_outbound_trg
  AFTER INSERT ON public.sms_messages
  FOR EACH ROW EXECUTE FUNCTION public.sms_mark_first_outbound();

-- Backfill what is already there, so the report has history rather than
-- starting from today. Earliest outbound per conversation.
UPDATE public.sms_conversations c
   SET first_outbound_at = m.first_at
  FROM (
    SELECT conversation_id, MIN(created_at) AS first_at
      FROM public.sms_messages
     WHERE direction = 'outbound'
     GROUP BY conversation_id
  ) m
 WHERE m.conversation_id = c.id
   AND c.first_outbound_at IS NULL;

-- ── 2. What the agent actually said, by intent ────────────────────────────
--
-- qualification_stage is derived from the intents the agent has chosen so far,
-- and the only record of an intent was sms_drafts.intent. That is fine while
-- every reply is reviewed by a person — and empty the moment autosend is on,
-- because the autosend and held-reply paths send without ever writing a draft
-- row.
--
-- Two things were broken by that, not one. The funnel was the visible half.
-- The invisible half: draftReply derives the CURRENT stage from those same
-- draft rows, so on an autosending workspace the agent believed it was
-- permanently at stage 0 and its own validator refused ask_address,
-- ask_contact and ask_availability as out-of-order, forever.
--
-- Recording the intent on the message fixes both, because every reply writes a
-- message whether or not a person approved it.
ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS agent_intent TEXT;

COMMENT ON COLUMN public.sms_messages.agent_intent IS
  'The intent the agent chose for this outbound message. Null for campaign steps and for messages a person wrote. Feeds qualification_stage and the agent''s own sense of how far the conversation has got — see migration 20260922114500.';

COMMENT ON COLUMN public.sms_conversations.first_outbound_at IS
  'When we first said anything. With sf_created_at this is speed-to-lead. Filled by sms_mark_first_outbound_trg rather than by any send path, because there are four of those and a trigger cannot be forgotten.';
