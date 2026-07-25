-- 076_commercial_user_slack.sql
-- Per-user Slack delivery for Commercial notifications (Karan 2026-07-25).
--
-- Each user can paste their own Slack Incoming Webhook URL. When enabled, every
-- commercial notification they'd get in the bell is ALSO posted to their Slack.
-- It's a personal mirror of the bell — one row per user, opt-in, off until they
-- paste a webhook and flip it on.
--
-- The webhook URL is a secret (anyone with it can post to that channel), so this
-- table is service-role only (RLS denies anon/authenticated). Reads + writes go
-- through owner-scoped server helpers.

CREATE TABLE IF NOT EXISTS public.commercial_user_slack (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  webhook_url  TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.commercial_user_slack ENABLE ROW LEVEL SECURITY;
