-- Migration 194: WHY a conversation is good, not just that it is.
--
-- Karan, 2026-09-08: "if its good we give reasons why its good... training
-- right now is a bit light and that's really important."
--
-- He is right, and the reason is worth stating. Emily's prompt contains roughly
-- twenty specific rules — ask one question at a time, never echo the customer's
-- wording, require an off-site quote when they have no property access, never
-- quote a price. A conversation labelled "good" with nothing else attached
-- cannot teach any of them. Retrieval picks examples by similarity, so an
-- untagged corpus surfaces whatever LOOKS like the current conversation rather
-- than whatever DEMONSTRATES the rule it needs.
--
-- The tag vocabulary is Emily's own rules, and it is shared between good and
-- bad examples: the same tag with conduct='good' means the conversation
-- demonstrates the rule, with conduct='bad' it means it violated it. One
-- vocabulary, both directions, and coverage becomes answerable — "we have
-- forty good examples and none of them show the off-site-required rule" is a
-- gap nobody could see from a pile of labels.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_training_tags (
  key         TEXT PRIMARY KEY,
  -- Which part of the prompt this belongs to, so the coverage report groups
  -- the way the instructions are written.
  section     TEXT NOT NULL CHECK (section IN ('flow','quote_type','qualification','handling','ending','tone')),
  label       TEXT NOT NULL,
  -- What a reviewer should be looking for. Kept here rather than in the UI so
  -- the definition and the tag cannot drift apart.
  what_to_look_for TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  SMALLINT NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS public.sms_training_example_tags (
  example_id  UUID NOT NULL REFERENCES public.sms_training_examples(id) ON DELETE CASCADE,
  tag_key     TEXT NOT NULL REFERENCES public.sms_training_tags(key) ON DELETE RESTRICT,
  -- Free text from the reviewer. Optional, and deliberately secondary — the
  -- tag is what can be counted; this is what a person reads.
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  UUID,
  PRIMARY KEY (example_id, tag_key)
);

CREATE INDEX IF NOT EXISTS sms_training_example_tags_tag_idx
  ON public.sms_training_example_tags (tag_key);

-- Who graded it and when. A corpus nobody can attribute is a corpus nobody can
-- question, and the whole conduct-vs-outcome problem came from not knowing who
-- meant what by "good".
ALTER TABLE public.sms_training_examples
  ADD COLUMN IF NOT EXISTS graded_by UUID,
  ADD COLUMN IF NOT EXISTS graded_at TIMESTAMPTZ;

ALTER TABLE public.sms_training_tags         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_training_example_tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_training_tags_no_client         ON public.sms_training_tags;
DROP POLICY IF EXISTS sms_training_example_tags_no_client ON public.sms_training_example_tags;

-- ── The vocabulary, taken from Emily's live instructions ───────────────
INSERT INTO public.sms_training_tags (key, section, label, what_to_look_for, sort_order) VALUES
  ('flow_order',        'flow','Kept the required order','Project details, then address, then contact, then availability. Nothing skipped or reordered, even when an off-site quote replaces the appointment.',10),
  ('flow_details',      'flow','Collected project details','Got the general area — bedroom, deck, cabinets. Did not interrogate for specifics it does not need.',11),
  ('flow_address',      'flow','Collected a full address','Street number, street name AND zip. Asked only for the missing part when half was given.',12),
  ('flow_contact',      'flow','Confirmed contact details','Summarised what the integration already had rather than asking again.',13),
  ('flow_availability', 'flow','Collected availability','Asked using the right phrasing for the day of week. Treated "anytime" as open availability, not as "does not know".',14),

  ('offsite_suggested', 'quote_type','Offered an off-site quote','Customer wanted a quote today, could not meet within two weeks, or was outside business hours. Offered, not forced.',20),
  ('offsite_required',  'quote_type','Required an off-site quote','No property access, small job, wanted a price only, or asked for text. Did NOT offer an in-person appointment.',21),
  ('offsite_still_collected','quote_type','Still collected the basics','Even with an off-site quote, took project details, address and contact.',22),

  ('area_checked',      'qualification','Checked the service area','Validated the zip, or ended as Area not serviced with "Just a moment" rather than announcing it.',30),
  ('scope_refused',     'qualification','Refused out-of-scope work','Named it as not covered and ended as Discarded. Did not suggest another company.',31),
  ('price_refused',     'qualification','Refused to quote a price','Left pricing to the estimator, however hard the customer pushed.',32),
  ('no_invented_time',  'qualification','Did not invent availability','Never offered or confirmed a specific appointment time on its own.',33),

  ('one_question',      'tone','Asked one question at a time','Did not stack two asks into one message.',40),
  ('no_echo',           'tone','Did not echo the customer','No restating their words back, no "Thanks for letting me know".',41),
  ('brief_ack',         'tone','Kept acknowledgements short','"Okay!", "Got it" — not repeated thanks.',42),
  ('natural_voice',     'tone','Sounded like a person','Contractions, light structure. No em dashes, parentheses or ellipsis.',43),

  ('handled_photo',     'handling','Handled a photo','Accepted it and said it would go to the estimator once booked.',50),
  ('handled_reaction',  'handling','Handled a reaction','Treated a like on an informational message as confirmation, and on a QUESTION as not an answer.',51),
  ('handled_bot_q',     'handling','Handled "are you a bot"','Answered as Emily and ended as Bot Suspected.',52),
  ('handled_callback',  'handling','Handled a callback request','Ended as Schedule Follow-up rather than continuing to text.',53),
  ('handled_language',  'handling','Handled another language','Today this means transferring. Tag it so we can count how often we lose a Spanish speaker.',54),
  ('handled_multi_property','handling','Handled multiple properties','One property at a time, full flow each, contact reused.',55),
  ('handled_negative',  'handling','Handled something negative','Acknowledged it and ended as Bailout rather than pressing on.',56),

  ('ended_correctly',   'ending','Ended in the right state','The End: command matched what actually happened.',60),
  ('ended_too_early',   'ending','Ended too early','Gave up while the customer was still engaged.',61)
ON CONFLICT (key) DO UPDATE SET
  section = EXCLUDED.section, label = EXCLUDED.label,
  what_to_look_for = EXCLUDED.what_to_look_for, sort_order = EXCLUDED.sort_order;

COMMENT ON TABLE public.sms_training_tags IS
  'What a conversation demonstrates, drawn from Emily''s own instructions. Shared between good and bad examples: the same tag with conduct=good means it demonstrates the rule, with conduct=bad it violated it. Makes coverage answerable — "forty good examples, none showing the off-site-required rule" is invisible from labels alone. Migration 194.';
