-- Migration 019: New Platform foundation (Phase 0).
--
-- Sets up the per-user access flags + the commercial_* table conventions
-- that the New Platform (commercial OS) build will land on top of. See
-- docs/NEW_PLATFORM_PLAN.md and docs/NEW_PLATFORM_ARCHITECTURE.html for
-- the full design.
--
-- This migration ONLY adds the foundation. The 9 phase-specific tables
-- (commercial_accounts, commercial_opportunities, etc.) ship in their
-- respective phase migrations starting with 020.
--
-- Safe to re-run.

-- ============================================================
-- 1. Profile access flags
-- ============================================================
-- A single Supabase user can have access to: Command Center only, New
-- Platform only, both, or neither.
--
-- Command Center default: derived from existing is_admin (a profile with
-- is_admin=true keeps access). Workers WITH an sf_user_id also get
-- access — they're real reps on the residential side. Workers without a
-- mapping AND without admin start with no access (admin grants it).
--
-- New Platform default: false. Admin explicitly grants per-user.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS has_command_center_access BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS has_new_platform_access BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: every existing profile keeps Command Center access (they were
-- using it before this column existed). New Platform stays off until admin
-- flips per-user.
UPDATE public.profiles SET has_command_center_access = TRUE WHERE has_command_center_access IS NULL;
UPDATE public.profiles SET has_new_platform_access = FALSE WHERE has_new_platform_access IS NULL;

-- Index for the routes-by-access middleware lookup.
CREATE INDEX IF NOT EXISTS profiles_platform_access_idx
  ON public.profiles (has_command_center_access, has_new_platform_access)
  WHERE has_command_center_access = TRUE OR has_new_platform_access = TRUE;

-- ============================================================
-- 2. commercial_user_roles — finer-grained roles INSIDE New Platform
-- ============================================================
-- Once a user has has_new_platform_access=true, this table dictates what
-- they can do inside the New Platform: admin / estimator / pm /
-- superintendent / foreman / office / field. Multi-role allowed (a PM can
-- also be field-active on another project).

CREATE TABLE IF NOT EXISTS public.commercial_user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'estimator', 'pm', 'superintendent', 'foreman', 'office', 'field')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by_user_id UUID,
  UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS commercial_user_roles_user_idx
  ON public.commercial_user_roles (user_id);

-- ============================================================
-- 3. commercial_audit_log — every commercial_* write is logged here
-- ============================================================
-- The diagram's "Full audit trail on all records" technical note. Every
-- INSERT / UPDATE / DELETE on a commercial_* table writes a row here with
-- before/after JSON so any record's history is queryable for compliance.

CREATE TABLE IF NOT EXISTS public.commercial_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,           -- TEXT not UUID so we can log any-shaped id
  action TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  before_json JSONB,
  after_json JSONB,
  user_id UUID,                   -- nullable for system-driven writes
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: "show me the history of THIS record."
CREATE INDEX IF NOT EXISTS commercial_audit_log_row_idx
  ON public.commercial_audit_log (table_name, row_id, at DESC);

-- ============================================================
-- 4. commercial_settings — global tunable settings
-- ============================================================
-- Fiscal year start, retainage default %, invoice numbering format,
-- inbound bid email address, etc. Single-row-per-key pattern (key/value).
-- Read-only at app layer; admin-edited via a settings page.

CREATE TABLE IF NOT EXISTS public.commercial_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID
);

-- Seed defaults — admin overrides via settings page when New Platform is live.
INSERT INTO public.commercial_settings (key, value, description) VALUES
  ('fiscal_year_start_month', '1'::JSONB, 'Month (1-12) the commercial fiscal year starts'),
  ('retainage_default_pct', '5'::JSONB, 'Default retainage % held on contracts'),
  ('invoice_number_prefix', '"PPP-COM"'::JSONB, 'Prefix for commercial invoice numbers'),
  ('mvp_phase_target', '"phase_0"'::JSONB, 'Build phase the platform is currently on')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 5. Bootstrap Karan's New Platform access
-- ============================================================
-- Karan needs access immediately to build Phase 0 surfaces against his own
-- login. Admin gates everything else. Use the existing invoice contact
-- email as the canonical match (matches the user's profile row).
UPDATE public.profiles
   SET has_new_platform_access = TRUE
 WHERE LOWER(email) = LOWER('malhotrak038@gmail.com');

-- Grant Karan the admin commercial role so he's not blocked by future
-- per-role gates inside the New Platform.
INSERT INTO public.commercial_user_roles (user_id, role)
SELECT user_id, 'admin' FROM public.profiles
 WHERE LOWER(email) = LOWER('malhotrak038@gmail.com')
ON CONFLICT (user_id, role) DO NOTHING;
