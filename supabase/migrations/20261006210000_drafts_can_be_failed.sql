-- A draft that was SENT and could not be recorded as sent.
--
-- sendDraft hands the message to the carrier and then marks the draft 'sent'.
-- That update discarded its error, so a failure left the draft 'pending' with
-- only reviewed_at set — and the claim hold is two minutes, after which the
-- draft reappears in the queue and the next reviewer sends the customer the
-- same text a second time. Autosend is off everywhere, so this is the path
-- every single reply takes today.
--
-- The code now retries the close and, failing that, takes the draft out of the
-- queue permanently. 'failed' is the honest state for it: not sent-and-filed,
-- not rejected by a person, but closed so that nobody sends it twice, with the
-- reason on send_error for whoever looks.
--
-- Until this is applied the code falls back to 'rejected', which the CHECK
-- already allows and which is also terminal — so the customer is protected
-- either way, and this migration only makes the record accurate.

ALTER TABLE public.sms_drafts
  DROP CONSTRAINT IF EXISTS sms_drafts_state_check;

ALTER TABLE public.sms_drafts
  ADD CONSTRAINT sms_drafts_state_check
  CHECK (state IN ('pending', 'sent', 'rejected', 'superseded', 'failed'));

COMMENT ON COLUMN public.sms_drafts.state IS
  'pending: waiting for a person. sent: a person approved it and it left. '
  'rejected: a person declined it. superseded: a newer draft replaced it. '
  'failed: it reached the carrier and we could not record that — closed so it '
  'cannot be sent a second time, reason on send_error.';
