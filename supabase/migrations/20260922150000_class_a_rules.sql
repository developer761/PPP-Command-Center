-- Kate's Class A rules, as data rather than a spreadsheet.
--
-- Sent 2026-09-22: 44 rules, 35 live and 9 retired, distilled from grading
-- Hatch's conversations. They are the standard the bot is written against AND
-- the standard raters mark against, which is exactly why they cannot keep
-- living in a CSV somebody re-exports — the bot and the rater have to be
-- reading the same row.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY THIS IS TWO TABLES
--
-- One column of Kate's sheet is headed, in her words:
--
--     "Rating guidance [RATER ONLY — NEVER give this to a bot]"
--
-- It tells a human how to judge a breach. Handing it to the model would teach
-- it to argue with its own grader, and to optimise for what the rater looks
-- at rather than for the customer.
--
-- "Do not select that column" is a convention, and conventions are how the
-- rater-only text ends up in a prompt eighteen months from now, in a query
-- somebody wrote in a hurry. So the rater-only text is in a DIFFERENT TABLE.
-- The bot-facing loader reads sms_class_a_rules and physically cannot leak
-- what is not there — SELECT * is safe, which is the property worth having.
--
-- The same table holds `history`, which Kate marks "PROVENANCE ONLY — rendered
-- nowhere": not dangerous, but not for any screen either.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sms_class_a_rules (
  -- A1 … A44. Kate's own ids, and they are load-bearing: raters tag breaches
  -- by code, retired codes must never be reused (A37 and A42 are explicitly
  -- BURNED), and a renumbering would silently re-point every historic tag.
  code              TEXT PRIMARY KEY,

  -- The rule in one line. Both the bot and the rater see this.
  statement         TEXT NOT NULL,

  -- The full rule card: what it means, the edge cases, the order of checks.
  -- Up to ~4,000 characters. Bot-facing, but far too large to put all 35 in
  -- every prompt — see lib/messaging/class-a-rules.ts.
  rule_card         TEXT,

  -- What a compliant message looks like, in Kate's words. Short, and the most
  -- useful thing to give a model that has just been told what not to do.
  corrective_action TEXT,

  -- 'critical' or 'mild' while live. Retired rules carry neither.
  severity          TEXT CHECK (severity IN ('critical','mild')),

  -- live: port this. retired: never tag, never build. Retired rules are KEPT
  -- rather than deleted — a rule that was merged into another still explains
  -- historic gradings, and deleting it is how a code gets reused by accident.
  status            TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','retired')),

  -- Wording rather than behaviour. A phrasing-only breach is a different
  -- conversation with the bot than a policy breach.
  phrasing_only     BOOLEAN NOT NULL DEFAULT FALSE,
  -- Whether the rule binds the bot, or is reference for the rater.
  binds             BOOLEAN NOT NULL DEFAULT TRUE,

  source            TEXT,
  measured_breaches TEXT,
  change_type       TEXT,
  last_modified     DATE,
  last_re_rated     DATE,

  -- Only live, binding rules with a statement can reach a prompt.
  CONSTRAINT sms_class_a_rules_live_shape CHECK (
    status <> 'live' OR (severity IS NOT NULL AND length(btrim(statement)) > 0)
  ),

  imported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.sms_class_a_rules IS
  'Kate''s Class A rules — the standard the bot is written against and raters mark against. BOT-SAFE: every column here may reach a prompt. Rater-only text lives in sms_class_a_rule_notes and deliberately not here.';

-- ── The half no bot may ever see ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sms_class_a_rule_notes (
  code             TEXT PRIMARY KEY REFERENCES public.sms_class_a_rules(code) ON DELETE CASCADE,

  -- "RATER ONLY — NEVER give this to a bot" (Kate's own heading).
  rating_guidance  TEXT,

  -- "PROVENANCE ONLY — rendered nowhere."
  history          TEXT,

  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.sms_class_a_rule_notes IS
  'RATER ONLY. Kate: "NEVER give this to a bot." Separated from sms_class_a_rules so the bot-facing loader cannot select it even by accident — the guarantee is structural, not a convention somebody has to remember.';

-- Live, binding rules in code order: the query the prompt builder makes.
CREATE INDEX IF NOT EXISTS sms_class_a_rules_live_idx
  ON public.sms_class_a_rules (status, severity)
  WHERE status = 'live';

ALTER TABLE public.sms_class_a_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_class_a_rule_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_class_a_rules_no_client ON public.sms_class_a_rules;
DROP POLICY IF EXISTS sms_class_a_rule_notes_no_client ON public.sms_class_a_rule_notes;
-- RLS on with no policy denies everyone but the service role, which is the
-- intent. Stated rather than left implicit — migrations 176-194 left exactly
-- this pattern undocumented and it reads like an omission.
CREATE POLICY sms_class_a_rules_no_client ON public.sms_class_a_rules FOR ALL USING (FALSE);
CREATE POLICY sms_class_a_rule_notes_no_client ON public.sms_class_a_rule_notes FOR ALL USING (FALSE);
