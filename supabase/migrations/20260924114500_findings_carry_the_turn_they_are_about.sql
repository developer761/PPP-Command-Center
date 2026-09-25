-- The sentence that broke the rule, stored beside the finding.
--
-- ── WHAT THIS BUYS ──────────────────────────────────────────────────────
--
-- The rule screens show findings like "reason clause on an ask" with nothing
-- to look at. Kate's 23 September export splits the findings into their own
-- files, one row per finding, and those rows carry two things the
-- conversation file does not: the TEXT of the turn, and the BASIS on which
-- the finding was reached. Her handover calls both files optional, and they
-- are, right up until somebody opens a rule and wants to know what the bot
-- actually said.
--
--   Turn Text  "Got it. Since it's one room, we can provide a quick quote
--               for this project. Do you prefer text or email?"
--   Basis      read · detector · read + detector · lookup · carve · day lookup
--
-- Basis is the more interesting of the two. It separates a finding a person
-- read and judged from one a mechanical check found, which is exactly the
-- distinction to draw when deciding whether a rule can be enforced in code.
--
-- ── AND A TURN LABEL, BECAUSE TURNS ARE NOT ALL INTEGERS ────────────────
--
-- turn_ordinal is INTEGER, and Kate's turns are not always whole: T2.2, T2.3
-- and T2.5 appear where a merged message is rated in parts. The parser's
-- pattern was T(\d+) followed by a bracket, so "T2.2 [A11 | critical]" did
-- not match at all and the ENTIRE FINDING WAS DROPPED. Eight of them, seven
-- defects and one good turn, silently absent from every count this repo has
-- produced.
--
-- Widening turn_ordinal to NUMERIC would work and would also quietly change
-- the meaning of a column a dozen places already read as an integer. The
-- label goes in its own column instead: turn_ordinal keeps the message it
-- belongs to, turn_label keeps what Kate wrote.
--
-- Safe to re-run.

ALTER TABLE public.sms_example_findings
  -- The bot's own words, as rated. Not the whole conversation — a turn can
  -- span several lines, and this is the anchor the finding hangs on.
  ADD COLUMN IF NOT EXISTS turn_text TEXT,
  -- How the finding was arrived at. Never inferred here: it is Kate's word
  -- for it, or nothing.
  ADD COLUMN IF NOT EXISTS basis TEXT,
  -- "T2.2". Kept verbatim so a fractional turn survives an integer column.
  ADD COLUMN IF NOT EXISTS turn_label TEXT;

-- The vocabulary as shipped. A CHECK rather than a lookup table because it is
-- six values that describe how a human graded something, and a new one should
-- be a decision somebody makes rather than a row that appears.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sms_example_findings_basis_known'
  ) THEN
    ALTER TABLE public.sms_example_findings
      ADD CONSTRAINT sms_example_findings_basis_known
      CHECK (basis IS NULL OR basis IN (
        'read', 'detector', 'read + detector', 'lookup', 'carve', 'day lookup'
      ));
  END IF;
END $$;

COMMENT ON COLUMN public.sms_example_findings.turn_text IS
  'The bot turn this finding is anchored to, verbatim. From Kate''s per-finding exports; absent for findings loaded before them.';
COMMENT ON COLUMN public.sms_example_findings.basis IS
  'How the finding was reached: read (a person), detector (a mechanical check), read + detector, or lookup/carve/day lookup for rules decided by a table. Separates a judgement from a measurement.';
COMMENT ON COLUMN public.sms_example_findings.turn_label IS
  'Kate''s own turn label, e.g. "T2.2". turn_ordinal is INTEGER and cannot hold a fractional turn; this can.';
