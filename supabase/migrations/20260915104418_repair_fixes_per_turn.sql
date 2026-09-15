-- A repair can fix several turns, and each fix says which turn and which rule.
--
-- Kate, 2026-09-15: "I can't rate more than one line." The cabinets
-- conversation had two wrong lines, T3 and T5, and the repair screen took one.
-- Repairing them one at a time would have produced two "good" examples, each
-- still carrying the other wrong line.
--
-- Each fixed turn becomes one sms_example_findings row on the ORIGINAL
-- conversation, the same shape her imported findings use: turn_ordinal is her
-- T-number, code is her A-code, what is what was wrong, should_have is the
-- line that replaced it. repair_id says which repair wrote it, so a repair can
-- be reopened with every fix it holds and the rated-conversations view can
-- show them per turn.
--
-- Safe to re-run.

ALTER TABLE public.sms_example_findings
  ADD COLUMN IF NOT EXISTS repair_id UUID
    REFERENCES public.sms_training_examples(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS sms_example_findings_repair_idx
  ON public.sms_example_findings (repair_id) WHERE repair_id IS NOT NULL;

COMMENT ON COLUMN public.sms_example_findings.repair_id IS
  'The repair (a derived sms_training_examples row) that wrote this fix. NULL for findings imported from Kate''s sheet. Migration 20260915104418.';

-- EDITING A SIGNED REPAIR UNSIGNS IT.
--
-- Migration 201 stops a repair being created already approved, because
-- somebody has to read it. Reopening a signed repair to add a fix changes what
-- was read, so the sign-off no longer covers it. Enforced here rather than
-- trusted to the screen, for the same reason as 201.
CREATE OR REPLACE FUNCTION public.sms_derived_edit_unapproves()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source = 'derived' AND NEW.transcript IS DISTINCT FROM OLD.transcript THEN
    NEW.approved := FALSE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sms_derived_edit_unapproves_trg ON public.sms_training_examples;
CREATE TRIGGER sms_derived_edit_unapproves_trg
  BEFORE UPDATE ON public.sms_training_examples
  FOR EACH ROW EXECUTE FUNCTION public.sms_derived_edit_unapproves();
