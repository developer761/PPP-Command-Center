-- An opt-out can be a sentence, and the table could not say so.
--
-- A24 is live and critical: "Any clear 'STOP', 'stop', or PLAIN-LANGUAGE
-- REQUEST to end or halt communication STOPS all further text outreach
-- immediately." Only the carrier keywords were honoured, so "stop texting me",
-- "take me off your list" and "leave me alone" all classified as normal and
-- the bot kept texting somebody who had asked it to stop.
--
-- Honouring them needs somewhere to say WHICH KIND OF EVIDENCE the opt-out
-- rests on. "They replied 'Stop.'" and "they wrote 'please stop texting me'"
-- are not the same claim if one is ever disputed, and sms_opt_outs.source
-- allowed only inbound_keyword, manual and hatch_import — so recording a
-- phrase opt-out failed the check constraint with 23514 and the webhook would
-- have answered 500 on the one path that must never drop a message.
--
-- Proved against the live database before writing this, by inserting each
-- candidate value and reading the error back, which is the only way to know
-- what a CHECK actually allows: the constraint in the repo and the constraint
-- in the database have disagreed before.

ALTER TABLE public.sms_opt_outs
  DROP CONSTRAINT IF EXISTS sms_opt_outs_source_check;

ALTER TABLE public.sms_opt_outs
  ADD CONSTRAINT sms_opt_outs_source_check
  CHECK (source IN ('inbound_keyword', 'inbound_phrase', 'manual', 'hatch_import'));

COMMENT ON COLUMN public.sms_opt_outs.source IS
  'How the opt-out arrived. inbound_keyword is a carrier keyword (STOP, END, '
  'UNSUBSCRIBE) typed as the whole message. inbound_phrase is A24 plain '
  'language ("take me off your list") found inside a message that may carry '
  'other content. manual is somebody in the office. hatch_import is the '
  'ported list.';
