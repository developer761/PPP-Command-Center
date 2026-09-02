-- Migration 186: suppression by phone OR email, not phone alone.
--
-- Kate's "Hatch → Salesforce opt-out failures" pull, 2024-11-14 to 2026-08-24:
--
--     213  opt-out notifications Salesforce could not match
--     121  arrived over SMS ... and 92 over EMAIL
--     115  do match an SF record today
--      98  have no SF record at all
--      55  match a record STILL not marked opted out
--      50  of those already existed when the opt-out fired
--
-- Two things follow.
--
-- First, 92 of 213 were EMAIL opt-outs, and PPP's campaigns send both channels
-- in one sequence — the CA LA campaign opens with an SMS and follows with an
-- email fifteen minutes later. A suppression list keyed only to a handset
-- cannot stop the email half. Email opt-out is CAN-SPAM rather than TCPA, but
-- it still has to be honoured, and honouring one channel while ignoring the
-- other is worse than either.
--
-- Second, and this is why the import must come from Hatch: 55 people told PPP
-- to stop and Salesforce still does not know, 50 of them with the record
-- sitting right there. Importing suppression from Salesforce would inherit
-- every one of those gaps on day one.
--
-- The table is empty (0 rows), so the primary key can be restructured safely.
-- Safe to re-run.

-- ORDER MATTERS. A primary key column cannot be nullable, so the key has to
-- move to `id` BEFORE phone_e164 can be relaxed. The first cut of this
-- migration tried to DROP NOT NULL first and Postgres refused:
--   ERROR 42P16: column "phone_e164" is in a primary key
-- Every step is guarded, so re-running after that partial failure is safe.

-- 1. New columns.
ALTER TABLE public.sms_opt_outs
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'sms';

-- 2. Move the primary key off phone_e164 and onto id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.sms_opt_outs'::regclass
       AND contype = 'p' AND conname = 'sms_opt_outs_pkey'
  ) AND EXISTS (
    -- only when the key is still the OLD one, on phone_e164
    SELECT 1 FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'public.sms_opt_outs'::regclass
       AND i.indisprimary AND a.attname = 'phone_e164'
  ) THEN
    ALTER TABLE public.sms_opt_outs DROP CONSTRAINT sms_opt_outs_pkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.sms_opt_outs'::regclass
       AND contype = 'p'
  ) THEN
    ALTER TABLE public.sms_opt_outs ADD CONSTRAINT sms_opt_outs_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- 3. Only NOW can phone become optional — an email-only opt-out has no
--    handset to record.
ALTER TABLE public.sms_opt_outs ALTER COLUMN phone_e164 DROP NOT NULL;

-- A row with neither identifier suppresses nobody and would sit in the table
-- looking like protection.
ALTER TABLE public.sms_opt_outs DROP CONSTRAINT IF EXISTS sms_opt_outs_has_identifier;
ALTER TABLE public.sms_opt_outs
  ADD CONSTRAINT sms_opt_outs_has_identifier
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL);

ALTER TABLE public.sms_opt_outs DROP CONSTRAINT IF EXISTS sms_opt_outs_channel_chk;
ALTER TABLE public.sms_opt_outs
  ADD CONSTRAINT sms_opt_outs_channel_chk CHECK (channel IN ('sms', 'email', 'both'));

-- Lowercase the email so Bob@ and bob@ cannot become two rows, one of which is
-- never checked — the same failure the E.164 normaliser exists to prevent.
DROP INDEX IF EXISTS sms_opt_outs_email_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS sms_opt_outs_email_active_idx
  ON public.sms_opt_outs (LOWER(email))
  WHERE email IS NOT NULL AND opted_in_at IS NULL;

DROP INDEX IF EXISTS sms_opt_outs_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS sms_opt_outs_phone_active_idx
  ON public.sms_opt_outs (phone_e164)
  WHERE phone_e164 IS NOT NULL AND opted_in_at IS NULL;

COMMENT ON COLUMN public.sms_opt_outs.email IS
  'Email opt-outs. 92 of the 213 failed Hatch opt-outs arrived over email, and PPP campaigns send both channels in one sequence — suppressing the SMS half only would keep emailing somebody who unsubscribed. Migration 186.';
COMMENT ON COLUMN public.sms_opt_outs.channel IS
  'Which channel the opt-out arrived on. "both" when the person is suppressed everywhere; the gate treats any matching row as suppression for that channel.';
