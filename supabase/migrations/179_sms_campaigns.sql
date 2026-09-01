-- Migration 179: campaigns as DATA, not code.
--
-- PPP edits campaigns in Hatch today. If they cannot edit them after cutover,
-- that is a regression and they will not agree to cancel — parity means parity
-- of CONTROL, not just of the messages that go out. So a campaign is rows, and
-- changing a follow-up delay is an edit, not a deploy.
--
-- Modelled on PPP's real "SF Leads Campaign - CA LA": SMS at launch, a 1 minute
-- delay, an email 15 minutes after the last message, then day 2 at 10:00 and
-- 18:30, day 3 at 09:00 and 11:15, day 4 at 09:00, day 5 at 11:15.
--
-- Three tables because a campaign has to be editable AND running conversations
-- must not change underneath themselves:
--   sms_campaigns          the stable identity ("SF Leads Campaign - CA LA")
--   sms_campaign_versions  an immutable published snapshot
--   sms_campaign_steps     the steps belonging to one version
--
-- A conversation pins the version it started on. Without that, editing step 3
-- on Tuesday sends someone mid-sequence a message that assumes a step 2 they
-- never received.
--
-- WHAT IS NOT HERE, DELIBERATELY: nothing in this file can widen quiet hours,
-- skip the opt-out check, or raise the per-customer daily cap. Those live in
-- the gate. A campaign author must not be able to configure their way into an
-- illegal send — no "urgent campaign, ignore quiet hours" checkbox, because
-- somebody will tick it at 10pm.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  -- NULL = available to every workspace; set = scoped to one. Hatch names them
  -- per workspace ("SF Leads Campaign - CA LA"), but the shape is shared.
  workspace_id     UUID REFERENCES public.sms_sub_accounts(id) ON DELETE CASCADE,
  -- What starts it. Named for the event, not the agent, so one trigger can
  -- feed several campaigns.
  trigger_event    TEXT NOT NULL CHECK (trigger_event IN (
                     'sf_lead_created', 'sf_opportunity_created', 'estimate_sent',
                     'appointment_scheduled', 'work_order_completed', 'manual'
                   )),
  -- Optional narrowing on the trigger payload (lead source, zip, etc.).
  audience_filter  JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Hatch exposes both of these per campaign. Holidays default OFF: a painting
  -- estimate chase on Thanksgiving morning reads badly even where it is legal.
  send_on_weekends BOOLEAN NOT NULL DEFAULT TRUE,
  send_on_holidays BOOLEAN NOT NULL DEFAULT FALSE,
  hatch_campaign_name TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, workspace_id)
);

CREATE TABLE IF NOT EXISTS public.sms_campaign_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES public.sms_campaigns(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  -- Set once, on publish. A published version is immutable: edits create the
  -- next version. Draft rows (published_at NULL) may be changed freely.
  published_at  TIMESTAMPTZ,
  published_by  UUID,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, version)
);

CREATE TABLE IF NOT EXISTS public.sms_campaign_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id    UUID NOT NULL REFERENCES public.sms_campaign_versions(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,

  -- PPP's campaign uses BOTH scheduling modes, so both are first-class:
  --   at_launch            fire immediately on entry
  --   delay_after_last     "email 15 min after last message was sent"
  --   absolute_on_day      "Day 2, 10:00 AM" in the WORKSPACE's timezone
  schedule_mode TEXT NOT NULL CHECK (schedule_mode IN ('at_launch','delay_after_last','absolute_on_day')),
  delay_minutes INTEGER CHECK (delay_minutes IS NULL OR delay_minutes >= 0),
  day_offset    INTEGER CHECK (day_offset IS NULL OR day_offset >= 0),
  time_of_day   TIME,

  channel       TEXT NOT NULL CHECK (channel IN ('sms','email')),
  subject       TEXT,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (version_id, ordinal),

  -- Each mode needs its own fields and must not carry the others', or a step
  -- can be saved that the scheduler cannot interpret.
  CONSTRAINT sms_campaign_steps_schedule_shape CHECK (
    (schedule_mode = 'at_launch'        AND delay_minutes IS NULL AND day_offset IS NULL AND time_of_day IS NULL)
 OR (schedule_mode = 'delay_after_last' AND delay_minutes IS NOT NULL AND day_offset IS NULL AND time_of_day IS NULL)
 OR (schedule_mode = 'absolute_on_day'  AND day_offset IS NOT NULL AND time_of_day IS NOT NULL AND delay_minutes IS NULL)
  ),
  -- An email with no subject is a deliverability problem, not a style choice.
  CONSTRAINT sms_campaign_steps_email_subject CHECK (channel <> 'email' OR subject IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS sms_campaign_steps_version_idx
  ON public.sms_campaign_steps (version_id, ordinal);
CREATE INDEX IF NOT EXISTS sms_campaigns_trigger_idx
  ON public.sms_campaigns (trigger_event) WHERE is_active = TRUE;

ALTER TABLE public.sms_campaigns          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_campaign_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_campaign_steps     ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_campaigns_no_client         ON public.sms_campaigns;
DROP POLICY IF EXISTS sms_campaign_versions_no_client ON public.sms_campaign_versions;
DROP POLICY IF EXISTS sms_campaign_steps_no_client    ON public.sms_campaign_steps;

COMMENT ON TABLE public.sms_campaigns IS
  'Campaign definitions as editable data. PPP edits these in Hatch today; losing that is a regression that would stop them cancelling. Nothing here can widen quiet hours, skip the opt-out check or raise the daily cap — those live in the gate. Migration 179.';
COMMENT ON TABLE public.sms_campaign_versions IS
  'Immutable published snapshots. A conversation pins the version it started on, so editing step 3 cannot send someone mid-sequence a message assuming a step 2 they never got.';
COMMENT ON COLUMN public.sms_campaign_steps.schedule_mode IS
  'PPP''s real campaign uses all three: SMS at launch, an email 15 min after the last message, and Day 2 at 10:00 in the workspace timezone.';
