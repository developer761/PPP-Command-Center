-- Why a rule says what it says.
--
-- Kate, 2026-09-22: "having a change/decision history for them… It would help
-- us grade performance if we look back over 6 months to see why x improved +
-- if a changed rule contributed to it."
--
-- What exists today is PROVENANCE, not history: each rule carries a source, a
-- change type and a last-modified date, plus a free-text History column that
-- is one blob per rule and, in her words, "may only be relevant to the
-- rule-building period". That answers "when did this last move" and not "what
-- moved, from what, and why".
--
-- ── IT HAS TO RECORD ITSELF ─────────────────────────────────────────────
--
-- A change log somebody has to remember to write is a change log that does not
-- exist in six months. Kate re-issues the rule sheet as she re-grades, and the
-- importer already re-runs against it — so the importer diffs what it is about
-- to write against what is there and records the difference. Nobody has to do
-- anything, and the history is a by-product of the work rather than a chore
-- beside it.
--
-- ONE ROW PER FIELD THAT MOVED, not one per import. "A22 severity went mild ->
-- critical on 2026-10-04" is a fact somebody can line up against a change in
-- the breach count. "A22 was edited" is not.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_class_a_rule_changes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL REFERENCES public.sms_class_a_rules(code) ON DELETE CASCADE,

  -- Which part of the rule moved.
  field       TEXT NOT NULL CHECK (field IN (
                'statement','rule_card','corrective_action','severity',
                'status','binds','phrasing_only','short_name','added'
              )),

  -- Kept verbatim. A diff that summarises is a diff nobody can check, and the
  -- whole point is being able to read what the rule used to say.
  before      TEXT,
  after       TEXT,

  -- Her own vocabulary from the sheet: BINDING means the rule's meaning
  -- changed, WORDING means it did not. That distinction is the one that
  -- matters when asking whether a change could have moved the numbers.
  change_type TEXT,

  -- Why, when anybody said. Free text on purpose.
  note        TEXT,

  -- 'import' for a re-issued sheet, or a user id for an edit made in the hub.
  changed_by  TEXT NOT NULL DEFAULT 'import',
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The query the rule page makes: this rule's history, newest first.
CREATE INDEX IF NOT EXISTS sms_class_a_rule_changes_code_idx
  ON public.sms_class_a_rule_changes (code, changed_at DESC);

-- And the one a six-month review makes: everything that moved in a window,
-- which is how a change gets lined up against a shift in the breach counts.
CREATE INDEX IF NOT EXISTS sms_class_a_rule_changes_when_idx
  ON public.sms_class_a_rule_changes (changed_at DESC);

ALTER TABLE public.sms_class_a_rule_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_class_a_rule_changes_no_client ON public.sms_class_a_rule_changes;
CREATE POLICY sms_class_a_rule_changes_no_client
  ON public.sms_class_a_rule_changes FOR ALL USING (FALSE);

COMMENT ON TABLE public.sms_class_a_rule_changes IS
  'One row per field of a rule that changed. Written by the import when Kate re-issues her sheet, so the history is a by-product of the work rather than something somebody has to remember. See lib/messaging/rule-diff.ts.';
