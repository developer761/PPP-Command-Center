-- 077_commercial_email_prefs.sql
-- Swap Slack delivery for email opt-in (Karan + Katie 2026-07-27).
--
-- Decision: notifications live in the Command Center bell/inbox — always, for
-- everyone. Email is now an OPT-IN extra: a user pastes an email address here
-- and turns it on to ALSO get their notifications by email. No Slack.
--
-- This migration:
--   1. drops the per-user Slack table (076) — Slack is removed entirely,
--   2. drops the per-rule to_slack flag (added in 075),
--   3. adds commercial_user_email_prefs (per-user opt-in notification email).

DROP TABLE IF EXISTS public.commercial_user_slack;

ALTER TABLE public.commercial_notification_rules DROP COLUMN IF EXISTS to_slack;

CREATE TABLE IF NOT EXISTS public.commercial_user_email_prefs (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Service-role only (the dispatcher + owner-scoped server helpers use the
-- service key). RLS denies direct anon/authenticated access.
ALTER TABLE public.commercial_user_email_prefs ENABLE ROW LEVEL SECURITY;
