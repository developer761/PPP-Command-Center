-- Migration 184: the chatbot's configuration, as data.
--
-- Emily's instructions in Hatch are one long prose block. It works, but it
-- means every change is a careful edit of a wall of text and nobody can see
-- what differs between workspaces. Here the parts that actually vary are
-- fields, and the prose that genuinely is prose stays prose.
--
-- Straight from PPP's live agent prompt:
--   persona           "Emily, the team's assistant"
--   required flow     Project Details -> Full Address -> Contact -> Availability
--   services          what PPP paints, and the excluded specialty list
--   off-site quote    when to suggest one, when it is required
--   business hours    9-5 M-F, 9-3 Sat; callbacks 8-6; slots 10-5
--   tone              one question at a time, no em dashes, no "Yep"
--
-- WHAT IS NOT HERE, AND WILL NOT BE: quiet hours, the opt-out check and the
-- per-customer daily cap. Those live in the gate. Nothing an operator types on
-- the agent screen can widen them, because the screen has no field for them.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_agent_configs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = the house default every workspace inherits. A row with a workspace
  -- overrides it for that workspace only, so "LA says Pasadena, NY says
  -- Melville" does not require duplicating the whole prompt.
  workspace_id      UUID REFERENCES public.sms_sub_accounts(id) ON DELETE CASCADE,

  persona_name      TEXT NOT NULL DEFAULT 'Emily',
  persona_role      TEXT NOT NULL DEFAULT 'the team''s assistant',

  -- The ordered flow. An array because the ORDER is the rule — Hatch's prompt
  -- says "follow in order unless a policy pauses or redirects".
  required_flow     JSONB NOT NULL DEFAULT '["project_details","full_address","contact_information","appointment_availability"]'::jsonb,

  -- Long-form sections, kept as prose because that is what they are.
  services_included TEXT,
  services_excluded TEXT,
  offsite_rules     TEXT,
  tone_rules        TEXT,
  office_location   TEXT,
  service_area_note TEXT,

  -- Behaviour the office actually tunes.
  confidence_threshold NUMERIC(3,2) NOT NULL DEFAULT 0.95
                       CHECK (confidence_threshold > 0 AND confidence_threshold <= 1),
  -- Draft-for-review until a workspace has earned autosend. Per workspace and
  -- never a global switch: a date on the calendar is not evidence.
  autosend             BOOLEAN NOT NULL DEFAULT FALSE,
  max_turns            SMALLINT NOT NULL DEFAULT 20 CHECK (max_turns BETWEEN 1 AND 100),

  -- Business hours the AGENT reasons about when offering slots. Distinct from
  -- the workspace's sending window, which is a legal bound in the gate. The
  -- agent may say "our earliest slot is 10 AM"; it can never authorise a send.
  booking_hours     JSONB NOT NULL DEFAULT '{"weekday":{"open":"10:00","close":"17:00"},"saturday":{"open":"09:00","close":"15:00"},"callback":{"open":"08:00","close":"18:00"}}'::jsonb,

  updated_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One default row, and at most one override per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS sms_agent_configs_default_idx
  ON public.sms_agent_configs ((workspace_id IS NULL)) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sms_agent_configs_ws_idx
  ON public.sms_agent_configs (workspace_id) WHERE workspace_id IS NOT NULL;

ALTER TABLE public.sms_agent_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_agent_configs_no_client ON public.sms_agent_configs;

-- ── Training corpus ────────────────────────────────────────────────────
-- The Hatch transcripts, and the distinction that decides whether this works:
-- a conversation can be well HANDLED and still lose, or badly handled and get
-- lucky with a motivated customer. Trained on outcome alone the model learns
-- to imitate luck, so conduct and outcome are separate columns and neither is
-- allowed to stand in for the other.
CREATE TABLE IF NOT EXISTS public.sms_training_examples (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL DEFAULT 'hatch' CHECK (source IN ('hatch','live','manual')),
  workspace_id  UUID REFERENCES public.sms_sub_accounts(id) ON DELETE SET NULL,

  transcript    JSONB NOT NULL,

  -- How it ENDED. Emily's own vocabulary, so imported rows need no mapping.
  outcome       TEXT CHECK (outcome IN (
                  'success','discard','schedule_follow_up','lost','bailout',
                  'phone_pricing','transferred','bot_suspected',
                  'msg_liked_loved','area_not_serviced'
                )),
  -- How it was HANDLED, judged independently of whether it booked.
  conduct       TEXT CHECK (conduct IN ('good','mixed','bad')),
  conduct_note  TEXT,

  -- PII must be stripped before any of this reaches a model.
  pii_scrubbed  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Only rows a human has actually reviewed are eligible for retrieval.
  approved      BOOLEAN NOT NULL DEFAULT FALSE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sms_training_usable_idx
  ON public.sms_training_examples (conduct, outcome)
  WHERE approved = TRUE AND pii_scrubbed = TRUE;

ALTER TABLE public.sms_training_examples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_training_examples_no_client ON public.sms_training_examples;

COMMENT ON COLUMN public.sms_training_examples.conduct IS
  'How the conversation was HANDLED, judged separately from whether it booked. A well-run conversation can lose an unqualified lead and a sloppy one can get lucky; training on outcome alone teaches the model to imitate luck.';
COMMENT ON TABLE public.sms_agent_configs IS
  'Chatbot configuration per workspace, with a NULL-workspace row as the inherited default. Cannot express quiet hours, the opt-out check or the daily cap — those live in the gate and have no field here. Migration 184.';
