-- Migration 200: Kate's audit taxonomy, and per-turn findings.
--
-- She sent 50 graded conversations on 2026-09-11 with 112 per-turn findings,
-- 69 of them carrying an explicit correction. The corpus had four examples and
-- none the bot could copy, so this is the difference between a training module
-- that works and one that does not.
--
-- HER CODES MAPPED TO OURS, from the findings themselves.
--
-- Retrieval selects examples BY RULE, so an example imported with no rule
-- attached is used but never aimed — when the bot is about to ask for an
-- address it would not preferentially see her examples about addresses. That
-- makes the mapping the difference between fifty conversations that help and
-- fifty that sit there.
--
-- Read off the evidence rather than the code names: every finding says what
-- actually went wrong, and 142 of them make most of these unambiguous. A23 is
-- twenty findings all about em dashes and parentheticals, which is our
-- natural_voice rule exactly. A13 is twenty-seven about confirming held
-- customer data instead of re-asking, which is flow_contact.
--
-- Four are left NULL on purpose, because the evidence does NOT settle them and
-- a wrong mapping is invisible: it would file every finding under a
-- plausible-looking wrong rule and look right on the coverage page. They are
-- named at the bottom of this file for Kate to settle.
--
-- SEVERITY IS ON THE FINDING, NOT THE CODE. A4 appears as mild, medium AND
-- critical in her sheet, because how badly a rule was broken depends on the
-- conversation rather than the rule. Putting it on the code would have forced
-- a false choice at import.
--
-- A TURN CAN BE BOTH. Her sheet lists the same turn under "Where It Fell
-- Short" and "Good Turns" — it fired the off-site quote immediately, which is
-- right, and said it clumsily. `kind` carries that rather than one verdict.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_audit_codes (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- What a reviewer should look for. Filled in as she describes them.
  description TEXT,
  -- Optional bridge to our own rule vocabulary. NULL until somebody maps it
  -- deliberately; a guess here would be invisible and wrong.
  tag_key     TEXT REFERENCES public.sms_training_tags(key) ON DELETE SET NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sms_example_findings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  example_id   UUID NOT NULL REFERENCES public.sms_training_examples(id) ON DELETE CASCADE,
  -- Which turn in the transcript. Her "T8".
  turn_ordinal INTEGER,
  code         TEXT REFERENCES public.sms_audit_codes(code) ON DELETE SET NULL,

  kind         TEXT NOT NULL CHECK (kind IN ('fell_short', 'did_well')),
  severity     TEXT CHECK (severity IN ('mild', 'medium', 'critical')),

  -- What it did.
  what         TEXT NOT NULL,
  -- What it should have done. Her "-> SHOULD HAVE:", and the single most
  -- valuable field here: a correction teaches, a complaint only labels.
  should_have  TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sms_example_findings_example_idx
  ON public.sms_example_findings (example_id);
CREATE INDEX IF NOT EXISTS sms_example_findings_code_idx
  ON public.sms_example_findings (code) WHERE code IS NOT NULL;

COMMENT ON COLUMN public.sms_example_findings.should_have IS
  'The correction. 69 of Kate''s 112 findings carry one, and they are what makes an example teach rather than merely label. Migration 200.';

-- Her Class A codes, as they appear in Batch 1 + 2.
INSERT INTO public.sms_audit_codes (code, name, tag_key, description) VALUES
  -- Unambiguous: the finding text says plainly which rule was broken.
  ('A2',  'Service Area',              'area_checked',        'Answered a service-area doubt and confirmed coverage.'),
  ('A3',  'Address From File',         'flow_address',        'Confirmed the address already on the record rather than asking for it.'),
  ('A4',  'Availability Ignored',      'flow_availability',   'Asked for availability the customer had already given.'),
  ('A5',  'Skipped Required Info',     'offsite_still_collected', 'Ended without collecting scope, address or contact.'),
  ('A6',  'Scope / off-site quote',    'offsite_required',    'A price-only or virtual request should fire the off-site path.'),
  ('A7',  'Off-site offered',          'offsite_suggested',   'Offered the off-site quote before pushing a visit.'),
  ('A9',  'Scope from the record',     'flow_details',        'Used the scope already on file instead of re-interrogating.'),
  ('A11', 'Redundant Ask',             'flow_address',        'Asked them to type an address we already held.'),
  ('A12', 'Skipped Required Info',     'flow_address',        'Accepted an address with no street number.'),
  ('A13', 'Customer Data',             'flow_contact',        'Re-asked for contact details already confirmed. Her most common finding.'),
  ('A15', 'Availability phrasing',     'flow_availability',   'Asked for a window instead of offering one.'),
  ('A16', 'Availability phrasing',     'flow_availability',   'Gave published hours without offering a slot.'),
  ('A17', 'Disposition',               'handled_negative',    'Kept pursuing after the customer said no.'),
  ('A21', 'Misc Awkward',              'natural_voice',       'Clumsy or repetitive wording.'),
  ('A22', 'Two asks in one message',   'one_question',        'Stacked two questions into a single message.'),
  ('A23', 'Tone',                      'natural_voice',       'Em dashes, parentheticals and ellipsis. Twenty of her findings.'),
  ('A24', 'Disposition',               'ended_correctly',     'The end state did not match what happened.'),
  ('A26', 'Photo Request Handling',    'handled_photo',       'Ignored photos the customer sent.'),
  ('A28', 'Misc Awkward',              'natural_voice',       'Clumsy wording, more serious.'),
  ('A30', 'Language',                  'handled_language',    'Customer wrote in Spanish; the bot replied in English throughout.'),
  ('A31', 'Customer Data',             'flow_contact',        'Contact details mishandled.'),
  ('A36', 'Availability',              'flow_availability',   'Weekend appointments are offered and the bot should say so.'),
  -- LEFT UNMAPPED DELIBERATELY. The findings do not settle these, and a wrong
  -- mapping is invisible — it would look right on the coverage page while
  -- filing every example under a rule it does not demonstrate.
  ('A8',  'Intent',                    NULL, 'NEEDS KATE: too few findings to tell which rule this is.'),
  ('A19', 'Tone',                      NULL, 'NEEDS KATE: overlaps A21/A23; unclear whether it is a separate rule.'),
  ('A25', 'Communication Preference',  NULL, 'NEEDS KATE: honouring a channel preference has no rule of ours yet.'),
  ('A29', 'Answerable question',       NULL, 'NEEDS KATE: about when to answer rather than defer. No rule covers it.'),
  ('A33', 'Deferred to estimator',     NULL, 'NEEDS KATE: like price_refused but about technique, not price.'),
  ('A34', 'v10 adjustment',            NULL, 'NEEDS KATE: version-specific, meaning unclear from the findings.'),
  ('A39', 'v10 adjustment',            NULL, 'NEEDS KATE: version-specific, meaning unclear from the findings.')
ON CONFLICT (code) DO UPDATE SET
  tag_key = EXCLUDED.tag_key,
  name = EXCLUDED.name,
  description = EXCLUDED.description;

ALTER TABLE public.sms_audit_codes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_example_findings  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_audit_codes_no_client      ON public.sms_audit_codes;
DROP POLICY IF EXISTS sms_example_findings_no_client ON public.sms_example_findings;
CREATE POLICY sms_audit_codes_no_client      ON public.sms_audit_codes      FOR ALL USING (FALSE);
CREATE POLICY sms_example_findings_no_client ON public.sms_example_findings FOR ALL USING (FALSE);
