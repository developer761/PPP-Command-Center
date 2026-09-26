-- A44 stalled conversations + A45 pause/resume calling.
--
-- The rule layer shipped in 2d789689 as pure, tested code with no database
-- behind it. This is the database half, kept deliberately small: it adds a
-- scheduled-action kind, one ending, and one table. It encodes no message
-- copy, because the spec supplies none and inventing customer-facing wording
-- in a migration is the wrong place for it.
--
-- ── WHAT A44 NEEDS ─────────────────────────────────────────────────────
--
-- Three follow-ups, one a day, at 10 AM / 3 PM / 6 PM the customer's local
-- time, shifted by A36's outbound hours. The instants are already computed by
-- followUpSchedule() in lib/messaging/stalled.ts; they need somewhere to sit
-- until they are due, and sms_scheduled_actions is exactly that queue.
--
-- Baseline this is meant to beat: of 237 stalled conversations in the
-- corpus, NONE received three follow-ups and 208 received none at all.
--
-- ── WHAT A45 NEEDS, AND WHY IT IS A TABLE AND NOT A COLUMN ─────────────
--
-- Two notifications to the call centre on one conversation: pause when the
-- customer replies, resume if the cadence is spent without reaching them.
--
-- The spec's hardest requirement is "One pause signal per conversation, not
-- one per reply — a customer who sends four messages does not generate four
-- pauses." That is a UNIQUE constraint, so it is enforced here rather than in
-- application code, where four concurrent inbound webhooks would each check
-- "has a pause gone?", each see no, and each send one.
--
-- Delivery is a seam on purpose. The spec: "How the notification is delivered
-- is deliberately unspecified and is not a blocker… where it lands is yours
-- to choose." So rows carry delivered_at and a last error, and nothing here
-- decides a transport.
--
-- 🔴 NEITHER SIGNAL WRITES TO SALESFORCE, and this table is not a Salesforce
-- mirror. sf_lead_id is carried so whoever reads the queue knows which lead
-- it is about. Nothing in this migration grants a write.

-- ── 1. A stall follow-up is a new kind of scheduled action ─────────────
--
-- The existing kinds are send_step, agent_turn, send_reply, followup_check
-- and close_stale, per 20260915135711 which last rewrote this constraint.
--
-- NOT probed against the live database, and saying so rather than implying
-- otherwise: the only probe that distinguishes "the CHECK rejects it" from
-- "the CHECK allows it" is an insert that succeeds when it allows it, which
-- is a write to production. The NULL-conversation_id probe returns 23502 for
-- every action and proves nothing. Written idempotently (DROP IF EXISTS,
-- then ADD) so it is correct either way.
--
-- NOT close_stale. That one exists to END a stale conversation, and A44 is
-- explicit that the opposite is required — "run the follow-up cadence and
-- then hand the conversation on — NEVER END IT."

ALTER TABLE public.sms_scheduled_actions
  DROP CONSTRAINT IF EXISTS sms_scheduled_actions_action_check;

ALTER TABLE public.sms_scheduled_actions
  ADD CONSTRAINT sms_scheduled_actions_action_check
  CHECK (action IN (
    'send_step', 'agent_turn', 'send_reply',
    'followup_check', 'close_stale',
    'stall_followup'
  ));

-- Which of the three this is. A44 is a fixed-length cadence, so the position
-- matters: the third one is the last, and the resume signal fires off it.
ALTER TABLE public.sms_scheduled_actions
  ADD COLUMN IF NOT EXISTS stall_step SMALLINT;

ALTER TABLE public.sms_scheduled_actions
  DROP CONSTRAINT IF EXISTS sms_scheduled_actions_stall_step_check;

ALTER TABLE public.sms_scheduled_actions
  ADD CONSTRAINT sms_scheduled_actions_stall_step_check
  CHECK (
    (action = 'stall_followup' AND stall_step BETWEEN 1 AND 3)
    OR (action <> 'stall_followup' AND stall_step IS NULL)
  );

-- ONE CADENCE PER CONVERSATION, and one row per step within it.
--
-- Without this, a stall sweep that runs twice — a retried cron, two workers,
-- a redeploy mid-run — queues six follow-ups and the customer gets chased
-- twice a day. Partial on state so a cancelled cadence can be re-queued if a
-- conversation stalls again later.
CREATE UNIQUE INDEX IF NOT EXISTS sms_scheduled_actions_stall_step_uniq
  ON public.sms_scheduled_actions (conversation_id, stall_step)
  WHERE action = 'stall_followup' AND state <> 'cancelled';

COMMENT ON COLUMN public.sms_scheduled_actions.stall_step IS
  'A44: which of the three stall follow-ups this row is (1, 2 or 3). NULL on '
  'every other kind of action. The third is the last, and A45''s resume '
  'signal fires off the end of it.';

-- ── 2. The ending A44 records ──────────────────────────────────────────
--
-- Spec: "the Hub records the ending as Stalled conversation, and Salesforce
-- is untouched."
--
-- It is an ending in OUR record only. Reaching the end of the cadence is not
-- a disposition — "nothing about the lead has changed and no CRM decision is
-- owed" — which is why it is added here and nowhere else.

ALTER TABLE public.sms_conversations
  DROP CONSTRAINT IF EXISTS sms_conversations_outcome_check;

ALTER TABLE public.sms_conversations
  ADD CONSTRAINT sms_conversations_outcome_check
  CHECK (outcome IN (
    'success', 'discard', 'schedule_follow_up', 'lost', 'bailout',
    'phone_pricing', 'transferred', 'bot_suspected',
    'msg_liked_loved', 'area_not_serviced',
    'stalled'
  ));

-- bot_suspected is kept in the list above ON PURPOSE even though A46 has just
-- stopped it being an ending: conversations closed under the old behaviour
-- still carry it, and dropping the value would make those rows unwritable.

-- ── 3. A45's two signals ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sms_call_signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.sms_conversations(id) ON DELETE CASCADE,

  kind            TEXT NOT NULL CHECK (kind IN ('pause_calling', 'resume_calling')),

  -- Which lead, for whoever reads the queue. Carried, never written back.
  sf_lead_id      TEXT,

  -- Why, in words. Must never read as a verdict on the lead: "A notification
  -- that reads as 'this lead is done' is the failure to avoid."
  note            TEXT NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The delivery seam. NULL means it has not gone yet; the destination is not
  -- decided here and this table does not care what it turns out to be.
  delivered_at    TIMESTAMPTZ,
  delivery_error  TEXT
);

-- THE SPEC'S HARDEST LINE, ENFORCED WHERE IT CANNOT BE RACED.
-- "One pause signal per conversation, not one per reply — a customer who
-- sends four messages does not generate four pauses."
CREATE UNIQUE INDEX IF NOT EXISTS sms_call_signals_one_per_kind
  ON public.sms_call_signals (conversation_id, kind);

-- The queue read: what has not gone out yet, oldest first.
CREATE INDEX IF NOT EXISTS sms_call_signals_undelivered_idx
  ON public.sms_call_signals (created_at)
  WHERE delivered_at IS NULL;

ALTER TABLE public.sms_call_signals ENABLE ROW LEVEL SECURITY;

-- Same shape as sms_scheduled_actions: no client reaches this table. It is
-- read and written by the server with the service role, and a signal that
-- could be forged from the browser would let anybody stop the call centre
-- dialling a lead.
DROP POLICY IF EXISTS sms_call_signals_no_client ON public.sms_call_signals;

COMMENT ON TABLE public.sms_call_signals IS
  'A45: the only two things that cross between the Hub and the call centre, '
  'and they cross in one direction. pause_calling when the customer replies '
  'to us; resume_calling when A44''s three follow-ups have gone unanswered. '
  'Neither edits the call cadence and neither writes to Salesforce. One row '
  'per (conversation, kind), enforced by a unique index rather than by '
  'application code, because four concurrent inbound webhooks would each '
  'check "has a pause gone?" and each get the same answer.';
