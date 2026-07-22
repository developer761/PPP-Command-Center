-- 072_user_roles_and_access.sql
-- User management + RBAC foundation for the residential Command Center.
--
-- Adds a first-class `role` to profiles (Admin / Account Manager / Sales Rep),
-- generalizing the existing boolean `is_admin`. Also tracks how the account
-- signs in (google SSO vs an admin-provisioned email+password), a display
-- name for provisioned users who have no Salesforce mapping, and an
-- append-only audit trail for every provisioning action.
--
-- Decisions (Karan 2026-07-22):
--   Roles      = admin | account_manager | rep
--   Login      = hybrid (Google SSO stays; admins can also provision
--                email+password accounts via Settings → Access)
--   Passwords  = admin sets initial; user can change their own later
--
-- `is_admin` is KEPT and mirrored (role='admin' <=> is_admin=true) so every
-- existing code path that reads `is_admin` keeps working during/after the
-- transition. Writes that set role also set is_admin, and vice-versa.

-- 1. Role -------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'rep'
    CHECK (role IN ('admin', 'account_manager', 'rep'));

-- Backfill: existing admins → role 'admin'. Everyone else stays 'rep'
-- (Account Managers get promoted individually via the Access tab).
UPDATE public.profiles SET role = 'admin' WHERE is_admin = TRUE AND role <> 'admin';

CREATE INDEX IF NOT EXISTS profiles_role_idx ON public.profiles (role);

-- 2. How the account authenticates -----------------------------------------
--    'google'   — the existing Google-SSO staff (default, no behavior change)
--    'password' — admin-provisioned email+password account
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'google'
    CHECK (auth_provider IN ('google', 'password'));

-- 3. Display name for provisioned users --------------------------------------
--    Google users get their name from Salesforce (sf_user_name) or Google.
--    A provisioned password user may have no SF mapping, so we store the name
--    the admin typed when creating the account.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS full_name TEXT;

-- 4. Access audit — append-only provisioning trail --------------------------
CREATE TABLE IF NOT EXISTS public.access_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,          -- admin who performed the action (nullable for system)
  actor_email   TEXT,
  action        TEXT NOT NULL, -- create_user | change_role | reset_password | set_active | delete_user
  target_user_id UUID,
  target_email  TEXT,
  detail        JSONB,         -- e.g. {"from":"rep","to":"account_manager"}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS access_audit_target_idx ON public.access_audit (target_user_id);
CREATE INDEX IF NOT EXISTS access_audit_created_idx ON public.access_audit (created_at DESC);

-- RLS: service-role only (admins read/write exclusively through server routes
-- that use the service-role client — same pattern as view_as_audit).
ALTER TABLE public.access_audit ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies → only the service role can touch this table.
