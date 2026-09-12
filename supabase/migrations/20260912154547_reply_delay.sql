-- How long Emily waits before replying.
--
-- Karan, 2026-09-12: a reply that lands the instant a customer hits send reads
-- as a machine, because it is one. A couple of minutes reads as somebody who
-- picked up their phone. The range is per workspace and adjustable precisely
-- so it can be tuned against real reply rates rather than guessed once.
--
-- A RANGE, NOT A NUMBER. A fixed three minutes every single time is its own
-- tell — the gap between message and reply would be identical to the second,
-- forever. The delay is drawn from between the two bounds each turn.
--
-- ZERO IS OFF, and is the default, so this changes nothing for any workspace
-- until somebody sets it. Both columns at 0 means reply as soon as the turn is
-- ready, which is today's behaviour.
--
-- CAPPED AT THIRTY MINUTES. Past a few minutes this stops being "a person got
-- to their phone" and becomes "nobody is reading this", and a lead going cold
-- is a worse outcome than sounding automated. The cap is a guard against a
-- typo in a settings box, not a considered maximum.
--
-- Safe to re-run.

ALTER TABLE public.sms_sub_accounts
  ADD COLUMN IF NOT EXISTS reply_delay_min_seconds SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reply_delay_max_seconds SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE public.sms_sub_accounts DROP CONSTRAINT IF EXISTS sms_sub_accounts_reply_delay_chk;
ALTER TABLE public.sms_sub_accounts
  ADD CONSTRAINT sms_sub_accounts_reply_delay_chk CHECK (
    reply_delay_min_seconds >= 0
    AND reply_delay_max_seconds >= 0
    AND reply_delay_min_seconds <= 1800
    AND reply_delay_max_seconds <= 1800
    -- An inverted range would silently disable the delay rather than erroring,
    -- which is exactly how an inverted quiet-hours window turned a workspace
    -- off without telling anybody.
    AND reply_delay_max_seconds >= reply_delay_min_seconds
  );

COMMENT ON COLUMN public.sms_sub_accounts.reply_delay_min_seconds IS
  'Lower bound on how long Emily waits before an auto-sent reply. 0 with max 0 means no delay. Applies only where autosend is on — a reply a person approves goes when they approve it.';
COMMENT ON COLUMN public.sms_sub_accounts.reply_delay_max_seconds IS
  'Upper bound on the same. Drawn fresh each turn so the gap is never identical twice. Capped at 1800 by constraint.';
