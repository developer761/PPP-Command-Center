-- The suppression list came from Salesforce, and the table could not say so.
--
-- Katie's export, 2026-09-25, pulled from leads and contacts:
--   Email_Opt_In__c = 'Opt-Out' OR HasOptedOutOfEmail = true   -> email
--   SMS_Opt_In__c   = 'Opt-Out'                                -> sms
--   DoNotCall       = true                                     -> voice
--
-- 33,197 suppression points. This is the list the send gate has been waiting
-- for: sms_opt_outs is empty, and gate-deps refuses every send while it is,
-- because an empty list answers "not suppressed" for everybody including the
-- people who already said stop.
--
-- sms_opt_outs.source allowed inbound_keyword, inbound_phrase, manual and
-- hatch_import. None of those is true of a Salesforce pull, and labelling it
-- as one of them would put the wrong answer in the evidence column if an
-- opt-out is ever disputed. Proved against the live constraint before writing
-- this: 'salesforce_import' failed the CHECK with 23514.
--
-- VOICE IS DELIBERATELY NOT ADDED. Connect Hub never places a call, and the
-- SMS suppression lookup matches on phone_e164 WITHOUT filtering channel — so
-- a DoNotCall row carrying a phone number would silently stop us texting
-- somebody who only asked not to be phoned. The 1,594 DoNotCall numbers stay
-- in Salesforce, where the people who dial read them.

ALTER TABLE public.sms_opt_outs
  DROP CONSTRAINT IF EXISTS sms_opt_outs_source_check;

ALTER TABLE public.sms_opt_outs
  ADD CONSTRAINT sms_opt_outs_source_check
  CHECK (source IN ('inbound_keyword', 'inbound_phrase', 'manual', 'hatch_import', 'salesforce_import'));

COMMENT ON COLUMN public.sms_opt_outs.source IS
  'How the opt-out arrived. inbound_keyword is a carrier keyword (STOP, END, '
  'UNSUBSCRIBE) typed as the whole message. inbound_phrase is A24 plain '
  'language ("take me off your list") found inside a message that may carry '
  'other content. manual is somebody in the office. hatch_import is the '
  'ported Hatch list. salesforce_import is Katie''s pull from Lead and '
  'Contact opt-out fields.';
