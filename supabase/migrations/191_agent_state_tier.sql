-- Migration 191: the state tier, and hard nos.
--
-- From the 2026-09-02 meeting: "Have the main chatbot and then sub chat bots
-- for each state which certain inclusions and certain data for that state only
-- so that chatbot follows the main chatbot along with the state specifics."
--
-- Today sms_agent_configs has two levels — a NULL-workspace default and a
-- per-workspace override. That is the wrong shape for what PPP actually has:
-- seven New York workspaces all answer "Garden City", all serve the same area,
-- and all share the same hard nos. Writing that seven times is the Hatch
-- problem in miniature, and the seventh copy is the one that drifts.
--
-- Three levels now:
--
--   scope='global'     one row. Office hours, tone, the hard nos, the required
--                      flow. What every conversation follows.
--   scope='state'      one row per state. Office location, service area
--                      wording, anything true of NY but not of Florida.
--   scope='workspace'  the exception. Most workspaces will never have one.
--
-- Resolution is global <- state <- workspace, and a NULL at a lower level means
-- "inherit", not "blank". That distinction is the whole point: an empty string
-- in a workspace override should be able to deliberately clear an inherited
-- value, while NULL means nothing was said.
--
-- HARD NOS are their own table rather than a text blob. Kate is compiling the
-- list of things the bot must never say or offer, and a list PPP can add a row
-- to — and see enforced, and see which conversations tripped it — is worth
-- more than a paragraph inside a prompt that nobody can point at.
--
-- Safe to re-run.

ALTER TABLE public.sms_agent_configs
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS state_code TEXT;

-- Existing rows: the NULL-workspace row is the global default; anything with a
-- workspace is a workspace override. Idempotent.
UPDATE public.sms_agent_configs
   SET scope = CASE WHEN workspace_id IS NULL THEN 'global' ELSE 'workspace' END
 WHERE scope NOT IN ('global','state');

ALTER TABLE public.sms_agent_configs DROP CONSTRAINT IF EXISTS sms_agent_configs_scope_chk;
ALTER TABLE public.sms_agent_configs
  ADD CONSTRAINT sms_agent_configs_scope_chk CHECK (scope IN ('global','state','workspace'));

-- Each scope must carry exactly the key it is scoped by, and no other. A state
-- row pointing at a workspace, or a global row carrying a state, is a row whose
-- resolution order is undefined.
ALTER TABLE public.sms_agent_configs DROP CONSTRAINT IF EXISTS sms_agent_configs_scope_shape;
ALTER TABLE public.sms_agent_configs
  ADD CONSTRAINT sms_agent_configs_scope_shape CHECK (
    (scope = 'global'    AND workspace_id IS NULL     AND state_code IS NULL)
 OR (scope = 'state'     AND workspace_id IS NULL     AND state_code IS NOT NULL)
 OR (scope = 'workspace' AND workspace_id IS NOT NULL AND state_code IS NULL)
  );

-- Exactly one global row, and one row per state.
DROP INDEX IF EXISTS sms_agent_configs_default_idx;
CREATE UNIQUE INDEX IF NOT EXISTS sms_agent_configs_global_idx
  ON public.sms_agent_configs ((scope)) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS sms_agent_configs_state_idx
  ON public.sms_agent_configs (state_code) WHERE scope = 'state';

COMMENT ON COLUMN public.sms_agent_configs.scope IS
  'global | state | workspace. Resolved global <- state <- workspace, with NULL meaning inherit. Migration 191.';

-- ── Hard nos ───────────────────────────────────────────────────────────
-- Kate's list of what the bot must never say or offer. A row, not a sentence
-- buried in a prompt, so it can be added to, enforced, and pointed at when a
-- conversation trips one.
CREATE TABLE IF NOT EXISTS public.sms_hard_nos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = applies everywhere. A state code narrows it: "we do not do stucco"
  -- may be true in New York and wrong in California.
  state_code  TEXT,
  -- What the bot must not do.
  rule        TEXT NOT NULL,
  -- Optional phrases that indicate the rule was tripped, for the post-filter.
  -- Kept separate from `rule` because the rule is for a human to read and the
  -- phrases are for a machine to match.
  phrases     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- What to do when it trips. 'block' rewrites before sending; 'escalate'
  -- hands to a person. Default escalate: a rule PPP cared enough to write down
  -- is a rule worth a human looking at, not a silent rewrite.
  on_trip     TEXT NOT NULL DEFAULT 'escalate' CHECK (on_trip IN ('block','escalate')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sms_hard_nos_active_idx
  ON public.sms_hard_nos (state_code) WHERE is_active = TRUE;

ALTER TABLE public.sms_hard_nos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_hard_nos_no_client ON public.sms_hard_nos;

COMMENT ON TABLE public.sms_hard_nos IS
  'What the bot must never say or offer. Kate owns the list. Rows rather than prose so PPP can add one and see it enforced, and so a tripped rule can be pointed at afterwards. Migration 191.';

-- ── Seed the state tier from what Kate already documented ──────────────
-- Her workspace notes give office and service area per region. These become
-- state rows; the per-workspace rows seeded in 188 stay and still win, which
-- is correct — NY LI Meta can differ from NY LI Nassau if it ever needs to.
INSERT INTO public.sms_agent_configs (scope, state_code, office_location, service_area_note)
VALUES
  ('state', 'NY', 'Garden City',  'We serve the majority of the area.'),
  ('state', 'NJ', 'Piscataway',   'We serve the majority of the area.'),
  ('state', 'FL', 'Coral Gables', 'We serve the majority of the area.'),
  ('state', 'CA', 'Pasadena',     'We serve the majority of the greater Los Angeles and Orange County area.'),
  ('state', 'CT', NULL,           'We serve the majority of the area.'),
  ('state', 'CO', NULL,           'We serve the Denver metro area.')
ON CONFLICT (state_code) WHERE scope = 'state'
DO UPDATE SET
  office_location   = EXCLUDED.office_location,
  service_area_note = EXCLUDED.service_area_note,
  updated_at        = NOW();
