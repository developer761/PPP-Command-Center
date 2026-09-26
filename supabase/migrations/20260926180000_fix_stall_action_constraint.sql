-- Corrective. The previous migration did not do what it said.
--
-- ── WHAT WENT WRONG ────────────────────────────────────────────────────
--
-- 20260926120000 tried to widen the `action` CHECK to admit
-- 'stall_followup'. It wrote:
--
--   DROP CONSTRAINT IF EXISTS sms_scheduled_actions_action_check;
--   ADD  CONSTRAINT          sms_scheduled_actions_action_check ...
--
-- The live constraint is called sms_scheduled_actions_action_**chk** — named
-- explicitly in 20260915135711, a file I had read and quoted the CONTENTS of
-- in that very migration's comments while missing its NAME.
--
-- So the DROP matched nothing, the ADD created a SECOND constraint, and both
-- now apply. The original still rejects 'stall_followup'.
--
-- It failed silently in exactly the way that is hardest to notice. The stall
-- sweep ran every minute, scanned 6 conversations, found 3 stalled, and got
-- 23514 on every insert — reporting `queued: 0`, which is also what a
-- correctly-idle sweep reports. Only running the sweep by hand and printing
-- its `skipped` map showed "insert failed 23514": 3.
--
-- I had written in that migration that the constraint was "NOT probed against
-- the live database". It should have been, and the name was sitting in a
-- committed file the whole time.

ALTER TABLE public.sms_scheduled_actions
  DROP CONSTRAINT IF EXISTS sms_scheduled_actions_action_chk;
ALTER TABLE public.sms_scheduled_actions
  DROP CONSTRAINT IF EXISTS sms_scheduled_actions_action_check;

ALTER TABLE public.sms_scheduled_actions
  ADD CONSTRAINT sms_scheduled_actions_action_chk
  CHECK (action IN (
    'send_step', 'agent_turn', 'send_reply',
    'followup_check', 'close_stale',
    'stall_followup'
  ));

-- ── AND THE OUTCOME CHANGE WAS WRONG ON ITS OWN TERMS ──────────────────
--
-- 20260926120000 also added 'stalled' to sms_conversations.outcome so A44
-- could record "the Hub records the ending as Stalled conversation".
--
-- That value can never be written, and should not be. 180_sms_conversations
-- carries a deliberate invariant:
--
--   CONSTRAINT sms_conversations_ended_shape CHECK (
--     (state = 'ended'  AND outcome IS NOT NULL AND ended_at IS NOT NULL)
--  OR (state <> 'ended' AND outcome IS NULL     AND ended_at IS NULL))
--
-- "A conversation is ended if and only if it carries an outcome." And A44 is
-- explicit that a stalled conversation is NEVER ended — "run the follow-up
-- cadence and then hand the conversation on." So stamping an outcome on a
-- live conversation asks the schema to hold two contradictory things.
--
-- The invariant is right and stays. The record that a cadence was spent is
-- the sms_call_signals row with kind='resume_calling', which already exists,
-- carries the reason, and is the thing the call centre acts on. A board that
-- wants to show "stalled" derives it from that rather than keeping a second
-- source of truth that can disagree.
--
-- The 'stalled' value is left in the outcome CHECK rather than removed: it is
-- unreachable, removing it is a no-op against real rows, and a future
-- iteration that genuinely ends a stalled conversation would want it back.
-- The application no longer writes it — see resumeCallingIfSpent.

COMMENT ON CONSTRAINT sms_scheduled_actions_action_chk ON public.sms_scheduled_actions IS
  'Which kinds of scheduled action exist. Widened 2026-09-26 for A44''s '
  'stall_followup. NOTE THE NAME: _chk, not _check — a migration that drops '
  'the wrong one silently leaves the old constraint in force alongside the '
  'new one, and every insert fails 23514 while the sweep reports queued: 0.';
