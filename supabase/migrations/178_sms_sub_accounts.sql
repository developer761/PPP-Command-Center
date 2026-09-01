-- Migration 178: sms_sub_accounts — the workspaces.
--
-- Modelled directly on Hatch's own Workspace Settings screen rather than on a
-- guess, so the replacement can represent everything PPP configures today.
-- Hatch groups them as General / Features / Team; the columns below follow the
-- same split.
--
-- 32 workspaces, 5 inactive, so 27 active — which is exactly the number of Pro
-- seats PPP is billed for, against only 7 human agents. Hatch is billing per
-- active workspace, not per person. Each workspace is a local phone number and
-- a routing bucket, segmented three ways at once:
--   region + service area   NY LI Nassau Leads, CO Denver Leads
--   lead source / channel   NY LI Meta, Google LSA, Thumbtack
--   AM- prefix              a separate account-management surface, so account
--                           management and call-centre traffic do not collide
--                           in one inbox (PPP's stated reason, 4/2026)
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_sub_accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ─── General (Hatch: Workspace Settings → General) ───
  name                  TEXT NOT NULL UNIQUE,
  initial               TEXT,
  company_name          TEXT,
  reply_to_email        TEXT,
  -- E.164. Nullable because Thumbtack currently has no number on file and a
  -- workspace without one must be representable rather than unrepresentable —
  -- pretending otherwise is how the row gets faked.
  phone_e164            TEXT CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- IANA, e.g. America/New_York. NOT NULL and no default on purpose: quiet
  -- hours are evaluated in THIS zone, and a wrong default is a silent TCPA
  -- violation in whichever state disagrees with it.
  time_zone             TEXT NOT NULL,

  -- ─── Business hours + after-hours (Hatch mirrors these) ───
  -- JSONB because it is one atomic decision read and written whole, and Hatch
  -- lets a workspace inherit another's hours rather than restate them.
  business_hours        JSONB NOT NULL DEFAULT '{}'::jsonb,
  inherits_hours_from   UUID REFERENCES public.sms_sub_accounts(id) ON DELETE SET NULL,
  after_hours_autoreply BOOLEAN NOT NULL DEFAULT FALSE,
  after_hours_message   TEXT,

  -- ─── Sending policy. Enforced by the gate, never by a campaign. ───
  -- A campaign author must not be able to configure their way past these.
  quiet_hours_start     SMALLINT NOT NULL DEFAULT 9  CHECK (quiet_hours_start BETWEEN 8 AND 20),
  quiet_hours_end       SMALLINT NOT NULL DEFAULT 20 CHECK (quiet_hours_end   BETWEEN 9 AND 21),
  CONSTRAINT sms_sub_accounts_quiet_window CHECK (quiet_hours_end > quiet_hours_start),
  send_on_weekends      BOOLEAN NOT NULL DEFAULT TRUE,
  send_on_holidays      BOOLEAN NOT NULL DEFAULT FALSE,

  -- ─── Features (Hatch: Workspace Settings → Features) ───
  call_forward_to       TEXT,
  voicemail_greeting_url TEXT,
  record_calls_default  BOOLEAN NOT NULL DEFAULT FALSE,

  -- ─── Rollout ───
  -- NY-first. Inactive workspaces exist as rows so a region is switched on by
  -- flipping a flag, never by a deploy.
  is_active             BOOLEAN NOT NULL DEFAULT FALSE,
  -- Draft-for-review until a workspace has earned autosend, per workspace and
  -- never as one global switch — a date on the calendar is not evidence.
  autosend_enabled      BOOLEAN NOT NULL DEFAULT FALSE,

  -- ─── Provenance ───
  hatch_workspace_name  TEXT,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Inbound routing: a message arrives addressed to a number and must resolve to
-- exactly one workspace. Partial unique index, so several workspaces may sit
-- numberless (Thumbtack) without colliding with each other on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS sms_sub_accounts_phone_idx
  ON public.sms_sub_accounts (phone_e164)
  WHERE phone_e164 IS NOT NULL;

CREATE INDEX IF NOT EXISTS sms_sub_accounts_active_idx
  ON public.sms_sub_accounts (is_active) WHERE is_active = TRUE;

ALTER TABLE public.sms_sub_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_sub_accounts_no_client ON public.sms_sub_accounts;

COMMENT ON TABLE public.sms_sub_accounts IS
  'Hatch workspaces. One local phone number + routing bucket each, segmented by region, lead source, or the AM- account-management prefix. 27 active of 32 — exactly the billed seat count, which is why Hatch appears to charge per workspace rather than per user. Migration 178.';
COMMENT ON COLUMN public.sms_sub_accounts.time_zone IS
  'IANA zone. Quiet hours are evaluated here, not on the server. PPP spans four zones; a wrong value is a silent TCPA violation.';
COMMENT ON COLUMN public.sms_sub_accounts.phone_e164 IS
  'Nullable: Thumbtack has no number on file as of the 4/2026 inventory. A workspace without a number must be representable rather than faked.';
