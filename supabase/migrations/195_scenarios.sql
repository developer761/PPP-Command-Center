-- Migration 195: the simulator, and why its output is NOT a training example.
--
-- Karan, 2026-09-08: a sandbox where Kate can play a customer, see how the bot
-- responds, and grade it. Good idea, and it fills a real hole — the coverage
-- report can say "offsite_required: nothing yet", and with historical data the
-- only remedy is to go hunting for a conversation that happens to exist. In a
-- simulator she can just CREATE one.
--
-- But there is a distinction that has to be drawn up front or this quietly
-- makes the corpus worse.
--
-- A retrieval example is something the bot IMITATES. Kate playing a customer is
-- Kate's idea of a customer, not a customer — fill the corpus with those and
-- the bot learns to handle her imagination. Real conversations stay the source
-- of what "good" looks like.
--
-- A graded simulator turn is something else, and more useful: a REGRESSION
-- TEST. "Given this customer message, in this scenario, the response should
-- look like this." Replay it after a prompt change and see what broke. Hatch
-- has nothing of the kind — PPP edits the instructions and finds out in
-- production.
--
-- So simulated turns live in their own tables, are marked as simulated, and
-- are never mixed into retrieval. The training corpus and the test suite are
-- different things that happen to be produced by the same screen.
--
-- Safe to re-run.

-- 'simulated' joins the sources, so an imported row can never be confused with
-- one Kate produced in the sandbox.
ALTER TABLE public.sms_training_examples DROP CONSTRAINT IF EXISTS sms_training_examples_source_check;
ALTER TABLE public.sms_training_examples
  ADD CONSTRAINT sms_training_examples_source_check
  CHECK (source IN ('hatch', 'live', 'manual', 'simulated'));

CREATE TABLE IF NOT EXISTS public.sms_scenarios (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  -- What Kate is playing. Given to her as a brief, not to the model — the bot
  -- must not know it is being tested.
  customer_brief TEXT NOT NULL,
  -- Which rule this exists to exercise. The link back to the coverage report:
  -- a gap becomes a scenario becomes a test.
  tag_key      TEXT REFERENCES public.sms_training_tags(key) ON DELETE SET NULL,
  -- Optional: run it as a particular workspace, so state-tier config is in play.
  workspace_id UUID REFERENCES public.sms_sub_accounts(id) ON DELETE SET NULL,

  -- Once every turn has been graded acceptable, this becomes a regression
  -- test: replay it after a prompt change and compare.
  is_regression_test BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at  TIMESTAMPTZ,
  last_run_passed BOOLEAN,

  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sms_scenario_turns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id  UUID NOT NULL REFERENCES public.sms_scenarios(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,

  -- What Kate typed as the customer.
  customer_text TEXT NOT NULL,

  -- What the bot produced. The structured action AND the rendered message,
  -- because a wrong intent with a plausible-looking message is the failure
  -- worth catching and only the action shows it.
  bot_intent   TEXT,
  bot_action   JSONB,
  bot_message  TEXT,
  confidence   NUMERIC(3,2),

  -- Kate's verdict on THIS response.
  verdict      TEXT CHECK (verdict IN ('good', 'acceptable', 'wrong')),
  verdict_note TEXT,
  -- What it should have done instead. The most valuable field on the table:
  -- "wrong" says something broke, this says what right looks like.
  expected_intent TEXT,

  graded_by    UUID,
  graded_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scenario_id, ordinal)
);

CREATE INDEX IF NOT EXISTS sms_scenario_turns_scenario_idx
  ON public.sms_scenario_turns (scenario_id, ordinal);
CREATE INDEX IF NOT EXISTS sms_scenarios_regression_idx
  ON public.sms_scenarios (is_regression_test) WHERE is_regression_test = TRUE;

ALTER TABLE public.sms_scenarios      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_scenario_turns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_scenarios_no_client      ON public.sms_scenarios;
DROP POLICY IF EXISTS sms_scenario_turns_no_client ON public.sms_scenario_turns;

COMMENT ON TABLE public.sms_scenarios IS
  'Simulated conversations for testing the bot. NOT retrieval examples — a simulated customer is somebody''s idea of a customer, and training on those teaches the bot to handle an imagination. Graded scenarios become regression tests instead: replay after a prompt change and see what broke. Migration 195.';
COMMENT ON COLUMN public.sms_scenario_turns.expected_intent IS
  'What it should have done. "wrong" records that something broke; this records what right looks like, which is what makes the scenario replayable.';
