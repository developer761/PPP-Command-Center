-- Conversation handoff: who has it, and can the bot still talk.
--
-- Migration 180 gave sms_conversations a 'human_active' state and an
-- owning_agent column. 193 added takeover_reason, takeover_at and an index on
-- them, plus a CHECK listing ten reasons. The inbox has a "Needs human" bucket
-- filtering on that state and reporting has a takeover rate built on it.
--
-- Nothing has ever written any of it. The bucket is permanently empty, the
-- takeover rate is permanently zero, and the thread badge that reads "You have
-- it" is unreachable. The escalation existed as far as the agent choosing to
-- escalate and a draft being filed for review, and stopped there — the
-- conversation never moved to a person.
--
-- WHY A SEPARATE owning_user_id. owning_agent is TEXT and the thread renders it
-- directly, so it holds a display name. A name cannot answer "is this mine",
-- which is the question every button on the handoff bar depends on, and two
-- people can share one. The id answers it; the name stays for display so no
-- existing read has to join.
--
-- WHAT RELEASE DOES NOT DO. Releasing clears the holder and the live state and
-- deliberately leaves takeover_reason and takeover_at alone. Those record that
-- a human was once needed here, which is the number reporting is built on —
-- clearing them on release would make every handled escalation vanish from the
-- metric the moment it was handled.
--
-- Safe to re-run.

ALTER TABLE public.sms_conversations
  ADD COLUMN IF NOT EXISTS owning_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sms_conversations.owning_user_id IS
  'Which signed-in person currently holds this conversation. NULL with state=human_active means it needs somebody and nobody has claimed it yet — that is the "Needs human" queue. owning_agent carries the display name for the same person.';

-- The "Needs human" bucket reads exactly this, and it is the one query in the
-- inbox that must stay fast when the other buckets are large.
CREATE INDEX IF NOT EXISTS sms_conversations_needs_human_idx
  ON public.sms_conversations (last_message_at DESC)
  WHERE state = 'human_active';

-- Claiming is an UPDATE guarded on owning_user_id IS NULL, so two people
-- clicking at the same moment resolve in the database rather than in the app:
-- one UPDATE matches a row, the other matches none. This partial index makes
-- that guard cheap.
CREATE INDEX IF NOT EXISTS sms_conversations_unclaimed_idx
  ON public.sms_conversations (id)
  WHERE state = 'human_active' AND owning_user_id IS NULL;
