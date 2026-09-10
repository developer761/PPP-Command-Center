-- Migration 199: PPP's real new-lead campaign, as data.
--
-- There were no campaigns in the system at all, so the opener a customer
-- actually receives — the one in every conversation Kate exported — did not
-- exist anywhere. Nothing could be enrolled and nothing could be sent.
--
-- Wording is taken VERBATIM from Kate's exports rather than rewritten:
--
--   "Hello, this is Precision Painting Plus. Thanks for requesting a free
--    estimate! Could you share details about your project and your
--    availability for an appointment? Call us at {number} with any questions.
--    Reply END to stop texts."
--
-- Two things about that text are deliberate. The phone number is left as a
-- placeholder because it differs per workspace and a hardcoded one would send
-- Nassau customers to the Queens office. And it already ends with "Reply END
-- to stop texts", which the gate recognises as a disclosure and therefore does
-- not add a second one to.
--
-- ENTRY AND EXIT come from Kate's real CA LA setup, which she keeps in Hatch
-- as an "Audience" and a "Lead Remove Rules Template". One rule set each,
-- shared by every workspace — the whole reason campaigns are many-to-many with
-- workspaces here is that Hatch forced PPP to duplicate this across 27 of them
-- and every wording change was 27 edits.
--
-- EVERYTHING IS CREATED INACTIVE. is_active is FALSE on the campaign and on
-- every workflow, and the version is left UNPUBLISHED. Nothing enrols and
-- nothing sends until somebody deliberately turns it on, which is not a
-- decision a migration should make on anybody's behalf.
--
-- Safe to re-run.

-- ── Entry: Kate's Audience ─────────────────────────────────────────────
INSERT INTO public.sms_rule_sets (name, kind, description)
VALUES ('New lead — web and phone inquiries', 'entry',
        'Kate''s Hatch audience: web and phone inquiries created today, excluding the marketplaces that have their own campaigns.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.sms_rules (rule_set_id, ordinal, field, operator, values)
SELECT s.id, v.ordinal, v.field, v.operator, v.values::jsonb
FROM public.sms_rule_sets s
CROSS JOIN (VALUES
  (1, 'RecordType',  'in',      '["Web Inquiry","Phone Inquiry"]'),
  (2, 'LeadSource',  'not_in',  '["Angi","Thumbtack","Google LSA"]'),
  (3, 'CreatedDate', 'on_date', '["today"]')
) AS v(ordinal, field, operator, values)
WHERE s.name = 'New lead — web and phone inquiries'
ON CONFLICT (rule_set_id, ordinal) DO NOTHING;

-- ── Exit: Kate's Lead Remove Rules ─────────────────────────────────────
INSERT INTO public.sms_rule_sets (name, kind, description)
VALUES ('Stop chasing — booked, qualified or opted out', 'exit',
        'Kate''s Hatch remove rules. Any one of these means the chase stops.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.sms_rules (rule_set_id, ordinal, field, operator, values)
SELECT s.id, v.ordinal, v.field, v.operator, v.values::jsonb
FROM public.sms_rule_sets s
CROSS JOIN (VALUES
  (1, 'IsConverted',                      'is_true',      '[]'),
  (2, 'Status',                           'in',           '["Qualified","Unqualified"]'),
  (3, 'SMS_Opt_In__c',                    'equals',       '["Opt-Out"]'),
  (4, 'Opportunity.AppointmentDate__c',   'is_not_blank', '[]'),
  (5, 'Opportunity.StageName',            'equals',       '["Opportunity Assigned"]')
) AS v(ordinal, field, operator, values)
WHERE s.name = 'Stop chasing — booked, qualified or opted out'
ON CONFLICT (rule_set_id, ordinal) DO NOTHING;

-- ── The campaign ───────────────────────────────────────────────────────
INSERT INTO public.sms_campaigns (name, workspace_id, trigger_event, is_active, hatch_campaign_name)
VALUES ('Leads Master Campaign', NULL, 'sf_lead_created', FALSE, 'Leads Master Campaign')
ON CONFLICT (name, workspace_id) DO NOTHING;

INSERT INTO public.sms_campaign_versions (campaign_id, version, notes)
SELECT c.id, 1, 'Seeded from Kate''s Hatch exports. Unpublished until reviewed.'
FROM public.sms_campaigns c
WHERE c.name = 'Leads Master Campaign' AND c.workspace_id IS NULL
ON CONFLICT (campaign_id, version) DO NOTHING;

-- The sequence. Verbatim wording; {{workspace_phone}} is filled at send time
-- because it differs per workspace.
INSERT INTO public.sms_campaign_steps (version_id, ordinal, schedule_mode, delay_minutes, day_offset, time_of_day, channel, subject, body)
SELECT ver.id, v.ordinal, v.mode, v.delay, v.day, v.tod::time, v.channel, v.subject, v.body
FROM public.sms_campaign_versions ver
JOIN public.sms_campaigns c ON c.id = ver.campaign_id AND c.name = 'Leads Master Campaign'
CROSS JOIN (VALUES
  (1, 'at_launch', NULL::int, NULL::int, NULL::text, 'sms', NULL::text,
   'Hello, this is Precision Painting Plus. Thanks for requesting a free estimate! Could you share details about your project and your availability for an appointment? Call us at {{workspace_phone}} with any questions. Reply END to stop texts.'),
  (2, 'delay_after_last', 30, NULL, NULL, 'email', 'Your free estimate from Precision Painting Plus',
   E'Hello,\n\nThanks for reaching out for a free estimate! We would love to hear more about your project. When would be a good time to discuss or schedule an appointment?\n\nYou can reply here or contact us via text or phone call at {{workspace_phone}}.\n\nLooking forward to speaking with you soon!\n\nPrecision Painting Plus'),
  (3, 'absolute_on_day', NULL, 1, '10:00', 'sms', NULL,
   'Hi, just following up on your estimate request. Are you still looking to get this done? Happy to get someone out to take a look.'),
  (4, 'absolute_on_day', NULL, 3, '10:00', 'sms', NULL,
   'Checking in one more time about your painting project. Let us know if you would still like an estimate and we will get it scheduled.')
) AS v(ordinal, mode, delay, day, tod, channel, subject, body)
WHERE ver.version = 1
ON CONFLICT (version_id, ordinal) DO NOTHING;

-- ── One workflow per live workspace, all switched OFF ───────────────────
INSERT INTO public.sms_workflows (name, campaign_id, workspace_id, entry_rules_id, exit_rules_id, run_mode, is_active, notes)
SELECT
  'Leads Master — ' || w.name,
  c.id, w.id, entry.id, exit_rules.id, 'immediately', FALSE,
  'Seeded by migration 199. Off until somebody turns it on.'
FROM public.sms_sub_accounts w
CROSS JOIN public.sms_campaigns c
CROSS JOIN public.sms_rule_sets entry
CROSS JOIN public.sms_rule_sets exit_rules
WHERE w.is_active
  AND w.name NOT LIKE 'AM - %'          -- account management, not new leads
  AND c.name = 'Leads Master Campaign' AND c.workspace_id IS NULL
  AND entry.name = 'New lead — web and phone inquiries'
  AND exit_rules.name = 'Stop chasing — booked, qualified or opted out'
ON CONFLICT (name, workspace_id) DO NOTHING;

-- And the many-to-many that replaces Hatch's one-campaign-per-workspace.
INSERT INTO public.sms_campaign_workspaces (campaign_id, workspace_id)
SELECT c.id, w.id
FROM public.sms_sub_accounts w
CROSS JOIN public.sms_campaigns c
WHERE w.is_active AND w.name NOT LIKE 'AM - %'
  AND c.name = 'Leads Master Campaign' AND c.workspace_id IS NULL
ON CONFLICT DO NOTHING;
