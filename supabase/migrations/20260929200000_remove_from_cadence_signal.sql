-- A25'S NOTIFICATION, WHICH DID NOT EXIST.
--
-- Kate's Iteration 1 spec, on Communication preference: "When the customer
-- names a channel, the bot continues the conversation in that channel and
-- sends a notification to the team to remove them from the Salesforce call
-- cadence." And, settled 24 September: "For Iteration 1 this stays a
-- notification and an agent removes them in Salesforce — build the signal,
-- not the cadence edit."
--
-- The signal was never built. `sms_call_signals` carried A45's two kinds and
-- nothing else, `statedChannelPreference` had zero production callers, and a
-- customer saying "stop calling me, just text" produced no notification at
-- all — so they stayed in the call cadence indefinitely.
--
-- ── WHY IT IS A THIRD KIND HERE AND NOT A NEW TABLE ────────────────────
--
-- It goes to the same place, carries the same three things (the lead, the
-- conversation, which signal it is), and shares the same delivery seam that
-- is deliberately unspecified. A second table would duplicate the queue read
-- and the delivery columns for one more row shape.
--
-- ── WHAT IT IS NOT ─────────────────────────────────────────────────────
--
-- Not a pause. The spec is explicit and the distinction has already been
-- confused once: "A pause is temporary; A25 is permanent. A25 fires when the
-- customer names a channel and asks to come off the phone for good. This
-- fires on any reply and lifts by itself. Do not implement one as the other."
--
-- It is also not a disposition. Nothing about the lead has changed — they
-- have said how they want to be contacted, not that they are uninterested —
-- and the existing `note` rule holds: a notification that reads as "this lead
-- is done" is the failure to avoid.
--
-- The one-per-kind unique index already covers it: a customer who says "text
-- only" three times generates one notification, the same way four replies
-- generate one pause.

ALTER TABLE public.sms_call_signals
  DROP CONSTRAINT IF EXISTS sms_call_signals_kind_check;

ALTER TABLE public.sms_call_signals
  ADD CONSTRAINT sms_call_signals_kind_check
  CHECK (kind IN ('pause_calling', 'resume_calling', 'remove_from_cadence'));

COMMENT ON COLUMN public.sms_call_signals.kind IS
  'pause_calling and resume_calling are A45''s pair — temporary, and the '
  'resume lifts the pause. remove_from_cadence is A25 and is PERMANENT: the '
  'customer named a channel and asked to come off the phone for good. '
  'Iteration 1 sends the notification only; an agent makes the change in '
  'Salesforce, per Kate 24 Sep. Nothing here edits a cadence or writes to '
  'Salesforce.';
