-- The new-lead entry rule excludes marketplaces by their Salesforce names.
--
-- Migration 199 seeded Kate's Hatch audience with LeadSource not_in
-- ["Angi","Thumbtack","Google LSA"]. Rules compare exact values, and
-- Salesforce does not call any Angi lead "Angi". Checked read-only against the
-- live Lead object on 2026-09-15, last 90 days:
--
--   Angi Quote Request          2,536   (the bulk of all Angi leads)
--   Angie's List Quote Request      4
--   Angi Ads                        2
--   Thumbtack                       1   (matches as seeded)
--   Google LSA                      0   (no such LeadSource value exists)
--
-- So the rule excluded no Angi lead at all: the moment a workflow is switched
-- on, every Angi quote request would get the general campaign on top of
-- Angi's own. The Salesforce spellings are added; the Hatch ones stay, since
-- they are harmless and a webhook payload might carry them.
--
-- "Google LSA" is left as it is and flagged for Kate: Salesforce has only
-- "Google" and "Google Ad Extension", and which of those (if either) is LSA
-- traffic is not something to guess. Excluding "Google" would drop 942 leads.
--
-- Safe to re-run.

UPDATE public.sms_rules r
   SET values = '["Angi","Angi Quote Request","Angi Ads","Angie''s List Quote Request","Thumbtack","Google LSA"]'::jsonb
  FROM public.sms_rule_sets s
 WHERE r.rule_set_id = s.id
   AND s.name = 'New lead — web and phone inquiries'
   AND r.field = 'LeadSource'
   AND r.operator = 'not_in';
