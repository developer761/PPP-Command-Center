-- A45 and A46 as rows, so the Rule Hub can show 37 live rules.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────
--
-- sms_class_a_rules holds 44 rules: 35 live and 9 retired. The Iteration 1
-- Build Spec's acceptance criterion for the Rule Hub is "All 37 live rules
-- are listed and the 9 retired ones are not." The 9 match exactly; the live
-- count is short by precisely these two, because Kate's export
-- (2026-09-25 hatch RULES.csv) stops at A44.
--
-- Both rules ARE specified — A45 and A46 each have a full card in the spec —
-- they simply have no row. The behaviour is already built and tested
-- (9ea81f3a for A45, 3b21ba50 for A46). This is the record catching up with
-- the code.
--
-- 🔴 THE TEXT BELOW IS DRAWN FROM THE SPEC, NOT AUTHORED BY KATE.
--
-- Every other row in this table came from her file, where the wording is hers
-- and the rater grades against it verbatim. These two are assembled from the
-- spec's own sentences — quoted, not paraphrased — but she has not written
-- them as rule cards and has not set their severity.
--
-- So they are marked in `source` as spec-derived. If she sends a RULES.csv
-- containing A45 and A46, the importer should OVERWRITE these rows and this
-- migration becomes history. Logged as question 1 in
-- docs/QUESTIONS_FOR_KATE.md.
--
-- Idempotent: ON CONFLICT (code) DO NOTHING, so re-running cannot clobber a
-- later import from her.

-- `source` records where a row's wording came from. Every existing row is
-- from her file and carries NULL; these two say otherwise so nobody mistakes
-- them for her text.
COMMENT ON COLUMN public.sms_class_a_rules.source IS
  'Where this row''s wording came from. NULL means Kate''s RULES.csv, which is '
  'the normal case and what the rater grades against. ''iteration_1_spec'' '
  'means it was assembled from the Iteration 1 Build Spec because her export '
  'did not carry the rule yet, and should be overwritten by her file when it '
  'does.';

INSERT INTO public.sms_class_a_rules (
  code, statement, rule_card, corrective_action,
  severity, status, phrasing_only, binds, source,
  change_type, last_modified
) VALUES

-- ── A45 ────────────────────────────────────────────────────────────────
(
  'A45',
  'Two notifications to the call centre on one conversation. Pause when the customer replies on text or email. Resume if that conversation is still stale at the end of A44''s follow-up cadence.',
  'WHY IT EXISTS: two teams were working the same customer on two channels with no signal between them. It is the one place the Hub and the call centre are wired together, and it runs in that direction only.  ||  '
  'WHAT GOOD LOOKS LIKE: while a customer is actively in conversation with the Hub, the phone team is not dialling them — nobody is worked on two channels at once. When the Hub has spent its own follow-ups without reaching them, the phone team gets them back rather than the lead going quiet on both sides.  ||  '
  '🔴 ONE PAUSE PER CONVERSATION, NOT ONE PER REPLY. A customer who sends four messages does not generate four pauses.  ||  '
  '🔴 THE RESUME FIRES ONLY AT THE END OF A44''S CADENCE, and only where the customer was never reached. A conversation that ends properly is not a resume.  ||  '
  '🔴 NEITHER SIGNAL EDITS THE CALL CADENCE ITSELF, AND NEITHER WRITES ANYTHING TO SALESFORCE.  ||  '
  'A PAUSE IS TEMPORARY; A25 IS PERMANENT. A25 fires when the customer names a channel and asks to come off the phone for good. This fires on any reply and lifts by itself. Do not implement one as the other.  ||  '
  'WHICH RULE OWNS WHICH HALF, FOR THE RATER: A45 is the pause only; the hand-back is A44''s, as shape (5) in its rating guidance, so a lead never handed back is an A44 defect, not an A45 one. A45 carries zero defects and zero good turns in the handover corpus, correctly — Hatch had no such capability, so a rater producing A45 findings on that corpus is miscalibrated.  ||  '
  'DELIVERY IS A SEAM ON PURPOSE. How the notification is delivered is deliberately unspecified and is not a blocker. Each signal carries the lead, the conversation, and which of the two signals it is.',
  'sent one pause when the customer replied and, where the cadence ended unreached, one resume — without editing the call cadence or writing to Salesforce',
  'critical',
  'live',
  false,
  true,
  'iteration_1_spec',
  'BINDING',
  '2026-09-25'
),

-- ── A46 ────────────────────────────────────────────────────────────────
(
  'A46',
  'Never claim to be a person. Disclose up front out of hours; in hours, answer truthfully only when asked.',
  'THE OLD INSTRUCTION IS RETIRED. Today''s bot is instructed to answer "I''m a real person!", and we are not willing to have it deny being a bot. The bot never claims to be a person, in any state.  ||  '
  'TWO WORDINGS, SPLIT BY WHETHER ANYONE IS ONLINE. In business hours the bot does not announce itself and answers truthfully only if asked. Out of hours it discloses up front, unprompted, on the front of the reply it was going to send anyway.  ||  '
  'APPROVED FINAL TEXT — build against these byte for byte, straight apostrophes included. IN HOURS, only in reply to being asked: "I''m an AI assistant, but I can take your project details and get you set up with an estimator. Would you prefer to speak with a member of our team?" OUT OF HOURS, prefixed to the reply already being sent: "I''m an AI assistant, but I can take your project details and pass them along once we open."  ||  '
  '🔴 BEING ASKED IS NOT AN ENDING. Asked directly in hours, the in-hours string is sent verbatim and the conversation carries on in the same thread.  ||  '
  '🔴 THE OUT-OF-HOURS LINE ADDS NO ASK — keep it that way. An earlier draft offered a callback and then appended a question, which stacks two asks in one message; A22''s second failure shape is exactly two questions a bare "yes" cannot disambiguate. The approved wording is a statement plus the reply already being sent, so it contributes no ask of its own. Do not reintroduce an offer or a question into the prefix — and no callback either: out of hours there is nobody to connect them to, and a promise with no owner is worse than none.  ||  '
  'THE PREFIX GOES ON THE FIRST REPLY OF THE CONVERSATION ONLY, followed by the reply itself — not on every message. Once the exchange is running, later replies carry no prefix. Nothing in the opener announces the bot during business hours.  ||  '
  'IN HOURS IS PER CUSTOMER, NOT PER CLOCK. The window is A36''s, resolved against the recipient''s own callable window rather than one global "are we open" flag.  ||  '
  'THIS IS A DECISION ABOUT HOW WE COME ACROSS, NOT A COMPLIANCE REQUIREMENT, and it applies in every state. We are not legally required to disclose — California and New Jersey both write their rule around a bot on a website or an app, and a text message is arguably neither. Build to the wording anyway.',
  'answered honestly that it is an AI assistant, or carried the approved out-of-hours disclosure on the first reply, without ever claiming to be a person',
  'critical',
  'live',
  false,
  true,
  'iteration_1_spec',
  'BINDING',
  '2026-09-25'
)

ON CONFLICT (code) DO NOTHING;
