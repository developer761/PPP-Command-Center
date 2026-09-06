-- Migration 190: workflows, and campaigns that can serve many workspaces.
--
-- From the 2026-09-02 meeting. Two structural changes Hatch forces on PPP that
-- we are deliberately not inheriting.
--
-- ONE. Hatch keeps AUDIENCE and WORKFLOW as separate objects, and a workflow
-- can only connect to a single audience. That is why PPP runs three
-- near-identical "SF Leads / Thumbtack / Angi" campaigns per region: not
-- because the messaging differs, but because Hatch's backend could not express
-- one audience covering several sources. Here a workflow holds its own entry
-- criteria, so one workflow covers what took three.
--
-- TWO. Hatch ties a campaign to one workspace, so the same sequence is
-- duplicated across 27 of them and every wording change is 27 edits. Here
-- campaigns are many-to-many with workspaces via sms_campaign_workspaces.
--
-- Shape taken from Kate's real CA LA setup:
--
--   ENTRY (her "Audience")      Record Type = Web Inquiry, Phone Inquiry
--                               Lead Source not in Angi, Thumbtack, ...
--                               Created Date = today
--                               Service Territory in (...)
--
--   EXIT (her "Lead Remove      IsConverted TRUE
--   Rules Template")            Status in Qualified, Unqualified
--                               SMS_Opt_In__c / Email_Opt_In__c = Opt-Out
--                               Opportunity.AppointmentDate__c not blank
--                               Opportunity.StageName = Opportunity Assigned
--
-- Note she calls the exit set a TEMPLATE. That is the right instinct and it is
-- modelled as one: a shared rule set, referenced by many workflows, so a change
-- to the removal rules happens once rather than in 27 places and drifting.
--
-- Criteria are structured rows, not free text, so the UI can render them, the
-- engine can evaluate them, and two workflows can be compared for overlap.
--
-- Safe to re-run.

-- ── Reusable rule sets (Kate's "templates") ────────────────────────────
CREATE TABLE IF NOT EXISTS public.sms_rule_sets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('entry', 'exit')),
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sms_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id UUID NOT NULL REFERENCES public.sms_rule_sets(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  -- Salesforce field path. "Opportunity.StageName" and "Contact.Email_Opt_Out__c"
  -- are both real examples from Kate's rules, so the dot is meaningful.
  field       TEXT NOT NULL,
  operator    TEXT NOT NULL CHECK (operator IN (
                'equals','not_equals','in','not_in','contains','not_contains',
                'is_blank','is_not_blank','is_true','is_false','on_date','within_days'
              )),
  -- Array so `in` / `not_in` need no separate shape. Operators that take no
  -- value (is_blank, is_true) carry an empty array.
  values      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rule_set_id, ordinal),
  -- A value-taking operator with no values matches nothing and would sit there
  -- looking like a filter. A valueless operator carrying values is a mistake
  -- worth catching at write time.
  CONSTRAINT sms_rules_value_shape CHECK (
    (operator IN ('is_blank','is_not_blank','is_true','is_false') AND jsonb_array_length(values) = 0)
 OR (operator NOT IN ('is_blank','is_not_blank','is_true','is_false') AND jsonb_array_length(values) > 0)
  )
);

CREATE INDEX IF NOT EXISTS sms_rules_set_idx ON public.sms_rules (rule_set_id, ordinal);

-- ── Campaigns serve many workspaces ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sms_campaign_workspaces (
  campaign_id  UUID NOT NULL REFERENCES public.sms_campaigns(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.sms_sub_accounts(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, workspace_id)
);

-- Carry across whatever the old single-FK column already said, so nothing is
-- lost when campaigns.workspace_id stops being the source of truth.
INSERT INTO public.sms_campaign_workspaces (campaign_id, workspace_id)
SELECT id, workspace_id FROM public.sms_campaigns WHERE workspace_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN public.sms_campaigns.workspace_id IS
  'SUPERSEDED by sms_campaign_workspaces (migration 190). Left in place so nothing breaks mid-migration; read the join table, not this.';

-- ── The workflow: entry + exit + campaign + cadence, in one place ──────
CREATE TABLE IF NOT EXISTS public.sms_workflows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  campaign_id   UUID NOT NULL REFERENCES public.sms_campaigns(id) ON DELETE CASCADE,
  -- Which workspace this workflow runs for. A campaign may serve several
  -- workspaces; a workflow is always scoped to one, because entry criteria and
  -- the overlap rule below are per workspace.
  workspace_id  UUID NOT NULL REFERENCES public.sms_sub_accounts(id) ON DELETE CASCADE,

  entry_rules_id UUID REFERENCES public.sms_rule_sets(id) ON DELETE RESTRICT,
  exit_rules_id  UUID REFERENCES public.sms_rule_sets(id) ON DELETE RESTRICT,

  -- Hatch's "How often?". Immediately is what PPP uses and what speed-to-lead
  -- requires; the interval option exists for anything that should not be.
  run_mode      TEXT NOT NULL DEFAULT 'immediately'
                CHECK (run_mode IN ('immediately', 'interval')),
  interval_minutes INTEGER CHECK (interval_minutes IS NULL OR interval_minutes > 0),

  is_active     BOOLEAN NOT NULL DEFAULT FALSE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, workspace_id),

  CONSTRAINT sms_workflows_interval_shape CHECK (
    (run_mode = 'immediately' AND interval_minutes IS NULL)
 OR (run_mode = 'interval'    AND interval_minutes IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sms_workflows_active_idx
  ON public.sms_workflows (workspace_id) WHERE is_active = TRUE;

ALTER TABLE public.sms_rule_sets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_rules                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_campaign_workspaces  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_workflows            ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_rule_sets_no_client           ON public.sms_rule_sets;
DROP POLICY IF EXISTS sms_rules_no_client               ON public.sms_rules;
DROP POLICY IF EXISTS sms_campaign_workspaces_no_client ON public.sms_campaign_workspaces;
DROP POLICY IF EXISTS sms_workflows_no_client           ON public.sms_workflows;

COMMENT ON TABLE public.sms_workflows IS
  'Audience + entry/exit criteria + campaign + cadence, as ONE definition. Hatch splits audience from workflow and allows one audience per workflow, which is why PPP runs three near-identical campaigns per region. Migration 190.';
COMMENT ON TABLE public.sms_rule_sets IS
  'Reusable criteria sets. Kate calls her removal conditions a "Lead Remove Rules Template" — modelled as an actual shared template so a change happens once rather than 27 times and drifting.';
