-- Migration 201: repaired conversations, kept honest about what they are.
--
-- Karan, 2026-09-11: "use the mid conversations, use the feedback of what
-- could be better and why it was mid to make better and decent conversations
-- and we can add them as mid/good for reference."
--
-- The material is there. All 34 of Kate's mid conversations carry an explicit
-- correction — "asked them to type the full address -> SHOULD HAVE: asked only
-- for the missing piece, by name" — so for each one we know what happened and
-- what should have happened instead.
--
-- THE SHARP EDGE. A repaired conversation is CONSTRUCTED. Somebody wrote what
-- they believe Emily should have said; the customer never received it. That is
-- the same hazard migration 195 named about simulated conversations, and it is
-- worse here in one specific way: a repair is built from a real transcript, so
-- it LOOKS real. Nothing about the text would tell you it never happened.
--
-- Three things keep it honest.
--
--   source='derived', for ever. It can never be counted as something a
--   customer actually received, and anything that wants only real
--   conversations can still ask for them.
--
--   derived_from points at the original. What changed is always answerable,
--   and a repair whose original was wrong can be found again.
--
--   approved is FALSE on creation and no script may set it true. A repair is
--   somebody's opinion about what good looks like until a second person agrees
--   — and a corpus of unreviewed repairs teaches the bot our guesses rather
--   than PPP's actual standard, which is the whole failure this guards against.
--
-- Safe to re-run.

ALTER TABLE public.sms_training_examples
  DROP CONSTRAINT IF EXISTS sms_training_examples_source_check;
ALTER TABLE public.sms_training_examples
  ADD CONSTRAINT sms_training_examples_source_check
  CHECK (source IN ('hatch', 'live', 'manual', 'simulated', 'derived'));

ALTER TABLE public.sms_training_examples
  ADD COLUMN IF NOT EXISTS derived_from UUID
    REFERENCES public.sms_training_examples(id) ON DELETE SET NULL;

-- Which finding it was repairing, so the correction and the repair stay
-- attached. A repair nobody can trace back to a reason is just a conversation
-- somebody wrote.
ALTER TABLE public.sms_training_examples
  ADD COLUMN IF NOT EXISTS derived_from_finding UUID
    REFERENCES public.sms_example_findings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sms_training_examples_derived_idx
  ON public.sms_training_examples (derived_from) WHERE derived_from IS NOT NULL;

COMMENT ON COLUMN public.sms_training_examples.derived_from IS
  'The real conversation this was repaired from. Set only when source = derived. What changed is always answerable. Migration 201.';

-- A repair may never be approved by the same act that created it.
--
-- Enforced rather than documented: a script that inserted an approved repair
-- would put a conversation nobody reviewed in front of the bot as something to
-- copy, and it would be indistinguishable from one a customer really received.
CREATE OR REPLACE FUNCTION public.sms_derived_starts_unapproved()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source = 'derived' AND NEW.approved THEN
    RAISE EXCEPTION 'a derived example cannot be created already approved — somebody has to read it first';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sms_derived_starts_unapproved_trg ON public.sms_training_examples;
CREATE TRIGGER sms_derived_starts_unapproved_trg
  BEFORE INSERT ON public.sms_training_examples
  FOR EACH ROW EXECUTE FUNCTION public.sms_derived_starts_unapproved();
