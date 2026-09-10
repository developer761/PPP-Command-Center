-- Migration 198: drafts waiting for a person.
--
-- Autosend is off everywhere and stays off for the first weeks, so every reply
-- the agent produces needs a human before it goes anywhere. There was nowhere
-- for those to live and no screen to read them on, which meant "test it before
-- we message real people" had no interface at all.
--
-- WHY NOT REUSE sms_scheduled_actions. That table is a queue of things to DO —
-- run an agent turn, send a campaign step. A draft is the OUTPUT of having
-- done one, and it has a different life: it is read by a person, possibly
-- rewritten, and then either sent or not. Overloading the action row would
-- mean a single row that is both "work to do" and "work awaiting judgement",
-- and the claim-and-retry logic would start competing with a human.
--
-- THE EDIT IS THE POINT. final_body is kept separately from body rather than
-- overwriting it, because the difference between what the agent wrote and what
-- the human sent is the most valuable training signal this system can produce.
-- It is a good example being authored as a by-product of somebody doing their
-- job, which is the only way a corpus ever gets filled. Overwriting body would
-- destroy exactly the thing worth keeping.
--
-- STALENESS IS A SAFETY PROPERTY, not tidiness. If the customer sends another
-- message while a draft is waiting, that draft is an answer to a question they
-- have already moved on from. Sending it makes the bot look like it is not
-- listening, which is the specific failure Kate graded conversations down for.
-- answers_message_id records what it was replying to so the screen can tell.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_drafts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES public.sms_conversations(id) ON DELETE CASCADE,

  -- The inbound this is a reply to. NULL for an opening message.
  answers_message_id UUID REFERENCES public.sms_messages(id) ON DELETE SET NULL,

  -- What the agent decided, kept so review teaches rather than just approves.
  intent           TEXT,
  confidence       NUMERIC(4,3),
  reasoning        TEXT,

  -- What it wants to send.
  body             TEXT NOT NULL,
  -- Why a person is looking at this at all.
  review_reason    TEXT NOT NULL DEFAULT 'autosend_off'
                   CHECK (review_reason IN ('autosend_off','low_confidence','escalated','negative_reaction','first_contact')),

  state            TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending','sent','rejected','superseded')),

  -- What a person actually sent, when they changed it. NULL means they sent
  -- the agent's wording unchanged.
  final_body       TEXT,
  reject_reason    TEXT,
  reviewed_by      UUID,
  reviewed_at      TIMESTAMPTZ,
  -- Set when the send was refused by the gate, so a draft is never silently
  -- marked sent when nothing left the building.
  send_error       TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The queue: oldest first, so nobody is left waiting longest.
CREATE INDEX IF NOT EXISTS sms_drafts_pending_idx
  ON public.sms_drafts (created_at) WHERE state = 'pending';

-- One pending draft per conversation. A second one would mean two people could
-- send two different replies to the same customer.
CREATE UNIQUE INDEX IF NOT EXISTS sms_drafts_one_pending_idx
  ON public.sms_drafts (conversation_id) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS sms_drafts_conversation_idx
  ON public.sms_drafts (conversation_id, created_at DESC);

COMMENT ON COLUMN public.sms_drafts.final_body IS
  'What the human actually sent, when it differs from body. The gap between the two is the training signal — never overwrite body with it. Migration 198.';

ALTER TABLE public.sms_drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_drafts_no_client ON public.sms_drafts;
-- Server-side only, like every other messaging table. The anon key is public.
CREATE POLICY sms_drafts_no_client ON public.sms_drafts FOR ALL USING (FALSE);
