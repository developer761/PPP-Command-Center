-- Migration 196: nurture is a second track, not a second bot.
--
-- Karan, 2026-09-08: "we need new leads probably and nurture."
--
-- Everything built so far assumes a NEW LEAD: qualify, collect project details,
-- address, contact and availability, hand to an estimator. PPP's other half of
-- the messaging volume is the opposite situation — the quote already went out,
-- the estimator already visited, and the job is to get a decision. Kate's real
-- campaigns are named for it: "Quote Sent Campaign - CT", "Completed Campaign".
--
-- The conversation Karan sent from AM - NJ is the shape:
--
--   Emily   friendly check-in on the quote Andres sent
--   Jeremy  "Still discussing it with my mother-in-law, the homeowner."
--   Emily   acknowledges, offers to help, asks when to check back
--
-- Running the new-lead prompt on that is actively wrong. It would ask a person
-- who has already had an estimator at their house for their address, which is
-- the single most obvious way to prove nobody is reading. The required flow,
-- the intents and the tone are all different, so the prompt has to be.
--
-- What it is NOT is a separate agent. Same persona, same hard nos, same
-- never-quote-a-price rule, same three-tier resolution — one more dimension on
-- the config that already exists. A workspace can therefore run the New York
-- new-lead rules and the global nurture rules at the same time, which is
-- exactly how PPP is organised: AM - NY, AM - NJ and AM - SoFlo are the
-- account-management surfaces and carry nurture, while the Leads and Meta
-- workspaces carry new leads.
--
-- Safe to re-run.

-- ── The track ──────────────────────────────────────────────────────────
ALTER TABLE public.sms_agent_configs
  ADD COLUMN IF NOT EXISTS track TEXT NOT NULL DEFAULT 'new_lead';

ALTER TABLE public.sms_agent_configs DROP CONSTRAINT IF EXISTS sms_agent_configs_track_chk;
ALTER TABLE public.sms_agent_configs
  ADD CONSTRAINT sms_agent_configs_track_chk CHECK (track IN ('new_lead','nurture'));

-- A conversation belongs to one track for its whole life. Which one decides
-- which prompt answers, so it is not derivable from the campaign alone —
-- a campaign can be retired while its conversations are still open.
ALTER TABLE public.sms_conversations
  ADD COLUMN IF NOT EXISTS track TEXT NOT NULL DEFAULT 'new_lead';

ALTER TABLE public.sms_conversations DROP CONSTRAINT IF EXISTS sms_conversations_track_chk;
ALTER TABLE public.sms_conversations
  ADD CONSTRAINT sms_conversations_track_chk CHECK (track IN ('new_lead','nurture'));

CREATE INDEX IF NOT EXISTS sms_conversations_track_idx
  ON public.sms_conversations (track, state);

-- ── Uniqueness now includes the track ──────────────────────────────────
-- Previously: one global row, one row per state, one per workspace. Now one of
-- each PER TRACK, or nurture could never have rules of its own.
DROP INDEX IF EXISTS sms_agent_configs_default_idx;
DROP INDEX IF EXISTS sms_agent_configs_ws_idx;
DROP INDEX IF EXISTS sms_agent_configs_global_idx;
DROP INDEX IF EXISTS sms_agent_configs_state_idx;

CREATE UNIQUE INDEX IF NOT EXISTS sms_agent_configs_global_idx
  ON public.sms_agent_configs (track) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS sms_agent_configs_state_idx
  ON public.sms_agent_configs (state_code, track) WHERE scope = 'state';
CREATE UNIQUE INDEX IF NOT EXISTS sms_agent_configs_ws_idx
  ON public.sms_agent_configs (workspace_id, track) WHERE scope = 'workspace';

COMMENT ON COLUMN public.sms_agent_configs.track IS
  'new_lead | nurture. Resolved independently of scope, so a workspace can take '
  'state new-lead rules and global nurture rules at once. Migration 196.';

-- ── The global nurture rules ───────────────────────────────────────────
-- Wording taken from PPP's live Quote Sent campaign rather than invented, so
-- the bot sounds like the team it is replacing on day one.
INSERT INTO public.sms_agent_configs (
  scope, track, workspace_id, state_code,
  persona_name, persona_role, required_flow,
  services_included, services_excluded, offsite_rules, tone_rules,
  confidence_threshold, autosend, max_turns
)
SELECT
  'global', 'nurture', NULL, NULL,
  COALESCE(g.persona_name, 'Emily'),
  'following up on quotes already sent',
  -- Not a collection flow. There is nothing left to collect: it is a decision
  -- funnel, and every step is something the CUSTOMER has to do.
  '["confirm_quote_received","answer_open_questions","ask_for_a_decision","agree_a_check_back_date"]'::jsonb,
  g.services_included,
  g.services_excluded,
  g.offsite_rules,
  'Warm, unhurried and never pushy. They have already had us at their home, so '
  || 'they are a customer, not a lead. Never ask again for anything they have '
  || 'already given — not the address, not the scope, not their contact details. '
  || 'Never re-quote, never discount, never imply a price has changed: the '
  || 'estimator owns the number and the quote already states it. If they are '
  || 'still deciding, that is a fine answer — acknowledge it, offer to answer '
  || 'questions, and agree when to check back. Chasing a person who has said '
  || '"not yet" is how we lose the job we already quoted.',
  COALESCE(g.confidence_threshold, 0.95),
  FALSE,
  COALESCE(g.max_turns, 12)
FROM public.sms_agent_configs g
WHERE g.scope = 'global' AND g.track = 'new_lead'
ON CONFLICT DO NOTHING;

-- Backfill: every conversation that exists today came from the new-lead build.
UPDATE public.sms_conversations SET track = 'new_lead' WHERE track IS NULL;
