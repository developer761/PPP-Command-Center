-- 075_commercial_notification_rules.sql
-- Custom notification rules (Block 3B) for the Commercial platform.
--
-- A rule is a personal alert a user defines: pick a trigger + a threshold +
-- a channel, and the daily cron notifies the OWNER when matching entities
-- appear. Fires are deduped per (rule, entity) so a rule alerts once per
-- entity, not every day the condition holds.
--
-- HARD CONSTRAINT: evaluation runs inside the EXISTING once-a-day commercial
-- cron (Vercel Hobby caps crons at 1/day). No new cron.

CREATE TABLE IF NOT EXISTS public.commercial_notification_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- Which condition the rule watches for.
  trigger        TEXT NOT NULL CHECK (trigger IN (
    'invoice_overdue',   -- an invoice N+ days past its due date
    'invoice_due_soon',  -- an invoice coming due within N days
    'invoice_paid',      -- an invoice paid in full (recent)
    'proposal_idle',     -- a Sent proposal with no response for N+ days
    'followup_due',      -- an opportunity whose follow-up date has arrived
    'opp_no_activity',   -- an open opportunity untouched for N+ days
    'deal_won',          -- a deal recently marked won
    'deal_lost'          -- a deal recently marked lost
  )),
  -- The "N days" for the trigger. followup_due ignores this.
  threshold_days INTEGER NOT NULL DEFAULT 7 CHECK (threshold_days >= 0 AND threshold_days <= 365),
  -- In-app (bell) delivery is always written. `channel` toggles email on top:
  -- 'bell' = in-app only, 'email' = + email, 'both' = + email (same as email).
  channel        TEXT NOT NULL DEFAULT 'both' CHECK (channel IN ('bell', 'email', 'both')),
  -- Additive Slack delivery (independent of `channel`). When true, this rule's
  -- alerts are also posted to the owner's connected Slack (commercial_user_slack).
  to_slack       BOOLEAN NOT NULL DEFAULT FALSE,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  last_evaluated_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS commercial_notification_rules_owner_idx
  ON public.commercial_notification_rules (owner_user_id);
CREATE INDEX IF NOT EXISTS commercial_notification_rules_enabled_idx
  ON public.commercial_notification_rules (enabled) WHERE enabled = TRUE;

-- Per-(rule, entity) fire log — the dedup key. A rule notifies once per
-- entity; re-entry with a NEW entity id fires again (different row).
CREATE TABLE IF NOT EXISTS public.commercial_notification_rule_fires (
  rule_id    UUID NOT NULL REFERENCES public.commercial_notification_rules(id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL,
  fired_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (rule_id, entity_id)
);

-- Service-role only (the cron + server actions use the service key). RLS
-- denies all direct anon/authenticated access.
ALTER TABLE public.commercial_notification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_notification_rule_fires ENABLE ROW LEVEL SECURITY;
