-- WHAT SALESFORCE SAID ABOUT SMS CONSENT, AT THE MOMENT WE ENROLLED THEM.
--
-- Twilio rejected the A2P campaign on 2026-10-10 for two things, and the
-- second one is the reason this column exists:
--
--   "We were unable to verify your Call-to-Action (CTA) or message flow...
--    [There is no proof provided for meta form opt in]"
--
-- We could not have provided it. Consent was nowhere in this database. The
-- estimate form on the website has carried a proper SMS consent checkbox the
-- whole time, and SMS_Opt_In__c exists on the Lead, but the only code that
-- ever read that field read it to STOP a conversation -- the exit rule, and
-- outcomeForExit. Nothing read it to decide whether to start one, and
-- consent_basis was the hardcoded string 'inquiry' on every row.
--
-- So a lead who ticked the box and a lead who was never asked produced
-- identical rows, and no query could tell them apart afterwards. That is the
-- thing that cannot be fixed retroactively: consent not recorded at the time
-- is consent that cannot be proved later.
--
-- Measured on 2026-10-10 against sf_lead_inbound, 1,584 leads:
--
--     517  LeadSource = Meta            none with SMS consent
--     562  Angi Quote Request           none with SMS consent (5 explicit Opt-Out)
--       8  (null source)                Opt-In (Verified)
--
-- Katie, 2026-10-08: "since we just split up SMS/Email consent, the consent
-- was recorded only for Emails... Moving forward, the actual consent will be
-- pushed to individual SMS / Email consent fields captured in Salesforce."
-- So this field is about to start carrying real values. These columns are
-- what catch them.
--
-- ── WHY NOT A NEW consent_basis VALUE ───────────────────────────────────
--
-- consent_basis is CHECK'd to ('inquiry','existing_relationship') and stays
-- that way. It answers "why are we allowed to text this person at all", and
-- for a lead who asked us for an estimate the honest answer really is the
-- inquiry. An express opt-in is not a different basis, it is EVIDENCE, and
-- evidence belongs in its own column where it can be null without lying.
--
-- Nullable, no default, no backfill. A null here means "we did not record it",
-- which is the truth about every conversation that already exists, and is
-- exactly the thing a default would paper over.

ALTER TABLE public.sms_conversations
  ADD COLUMN IF NOT EXISTS sms_consent_value   TEXT,
  ADD COLUMN IF NOT EXISTS sms_consent_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN public.sms_conversations.sms_consent_value IS
  'SMS_Opt_In__c exactly as Salesforce held it when this conversation was '
  'opened -- e.g. "Opt-In (Verified)", "Opt-In (Form)", "Opt-Out". NULL means '
  'Salesforce had no value, NOT that consent was refused. Recorded verbatim '
  'rather than normalised so that a picklist rename is visible as itself.';

COMMENT ON COLUMN public.sms_conversations.sms_consent_seen_at IS
  'When sms_consent_value was read off the lead. Pairs with the value so a '
  'consent recorded later cannot be mistaken for one held at enrolment.';
