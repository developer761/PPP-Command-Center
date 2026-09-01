-- Migration 180: conversations and messages.
--
-- The outcome vocabulary is lifted VERBATIM from Hatch's own agent prompt —
-- the "COMMAND End:" states Emily emits. Using PPP's existing words means the
-- office opens our inbox already knowing what every label means, and the
-- shadow-run comparison comes out like-for-like instead of needing a mapping
-- table nobody trusts.
--
-- One conversation per customer per workspace. NOT per customer: the same
-- person reaching PPP through Meta and Google LSA hits two different numbers,
-- and those are genuinely separate sales channels PPP reports on separately.
-- Suppression is still global — sms_opt_outs is keyed by handset, so a STOP in
-- one silences all of them.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_conversations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.sms_sub_accounts(id) ON DELETE RESTRICT,
  customer_phone      TEXT NOT NULL CHECK (customer_phone ~ '^\+[1-9][0-9]{7,14}$'),
  customer_name       TEXT,
  customer_email      TEXT,

  -- Live state. 'ai_active' and 'human_active' are the two ways a conversation
  -- can be in progress; exactly one owner at a time, which is what stops five
  -- agents talking over each other.
  state               TEXT NOT NULL DEFAULT 'ai_active'
                      CHECK (state IN ('ai_active','human_active','awaiting_customer','ended')),
  -- Which agent currently owns it. NULL while a human has taken over.
  owning_agent        TEXT,
  assigned_user_id    UUID,

  -- Terminal outcome, straight from Emily's COMMAND End: vocabulary.
  outcome             TEXT CHECK (outcome IN (
                        'success', 'discard', 'schedule_follow_up', 'lost', 'bailout',
                        'phone_pricing', 'transferred', 'bot_suspected',
                        'msg_liked_loved', 'area_not_serviced'
                      )),
  ended_at            TIMESTAMPTZ,

  -- The campaign version this conversation is executing. Pinned at entry so a
  -- mid-flight edit cannot send step 3 to somebody who never received step 2.
  campaign_version_id UUID REFERENCES public.sms_campaign_versions(id) ON DELETE SET NULL,

  -- Salesforce linkage, for status writeback.
  sf_lead_id          TEXT,
  sf_opportunity_id   TEXT,

  -- Why the send is lawful: 'inquiry' (they contacted PPP) or 'existing_relationship'
  -- (a customer with a job in flight). Recorded per conversation because the
  -- lead agents and the post-job agents do not stand on the same ground.
  consent_basis       TEXT NOT NULL DEFAULT 'inquiry'
                      CHECK (consent_basis IN ('inquiry','existing_relationship')),

  last_message_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A conversation is ended if and only if it carries an outcome. Without this
  -- a row can sit "ended" with no reason, or carry an outcome while still
  -- scheduling sends.
  CONSTRAINT sms_conversations_ended_shape CHECK (
    (state = 'ended' AND outcome IS NOT NULL AND ended_at IS NOT NULL)
 OR (state <> 'ended' AND outcome IS NULL AND ended_at IS NULL)
  )
);

-- One live conversation per customer per workspace. Ended ones stay as history,
-- so the partial index only guards the active row.
CREATE UNIQUE INDEX IF NOT EXISTS sms_conversations_live_idx
  ON public.sms_conversations (workspace_id, customer_phone)
  WHERE state <> 'ended';

CREATE INDEX IF NOT EXISTS sms_conversations_inbox_idx
  ON public.sms_conversations (workspace_id, state, last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.sms_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES public.sms_conversations(id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel          TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','email')),
  body             TEXT NOT NULL,
  subject          TEXT,

  -- Who produced it. Hatch surfaces the handling rep's name on the thread and
  -- PPP uses it for commission attribution, so it is not optional metadata.
  sent_by_agent    TEXT,
  sent_by_user_id  UUID,

  -- Provider identity, for delivery receipts AND idempotency. Webhooks retry;
  -- a duplicate outbound is a customer-visible defect.
  provider_id      TEXT,
  delivery_status  TEXT CHECK (delivery_status IN ('queued','sent','delivered','failed','undelivered')),
  failure_reason   TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Inbound dedupe: the same provider message must never land twice.
CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_provider_idx
  ON public.sms_messages (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_messages_thread_idx
  ON public.sms_messages (conversation_id, created_at);

ALTER TABLE public.sms_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_messages      ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_conversations_no_client ON public.sms_conversations;
DROP POLICY IF EXISTS sms_messages_no_client      ON public.sms_messages;

COMMENT ON COLUMN public.sms_conversations.outcome IS
  'Verbatim from Hatch''s agent prompt (COMMAND End: success / discard / schedule_follow_up / lost / bailout / phone_pricing / transferred / bot_suspected / msg_liked_loved / area_not_serviced). PPP''s existing words, so the shadow-run comparison is like-for-like.';
COMMENT ON COLUMN public.sms_conversations.campaign_version_id IS
  'Pinned at entry. A mid-flight campaign edit must not send step 3 to someone who never received step 2.';
