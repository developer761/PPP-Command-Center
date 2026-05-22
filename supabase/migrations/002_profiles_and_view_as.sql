-- 002_profiles_and_view_as.sql
-- Role-based access foundation:
--   profiles      — maps Supabase auth.users to SF User Id + admin flag
--   view_as_audit — logs every time an admin impersonates a rep
--
-- Run in Supabase SQL editor. Idempotent — safe to re-run.

-- ============================================================
-- profiles table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  sf_user_id TEXT,             -- null for admins without a SF rep mapping (e.g., Karan on gmail)
  sf_user_name TEXT,           -- denormalized for UI display when SF snapshot isn't loaded
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,  -- mirrors SF User.IsActive; we deny sign-in if false (admins exempt)
  last_login_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS profiles_email_idx ON public.profiles (lower(email));
CREATE INDEX IF NOT EXISTS profiles_sf_user_id_idx ON public.profiles (sf_user_id);
CREATE INDEX IF NOT EXISTS profiles_is_admin_idx ON public.profiles (is_admin) WHERE is_admin = TRUE;

-- RLS: users read own row only; service role full access.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_self_read ON public.profiles;
CREATE POLICY profiles_self_read ON public.profiles
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS profiles_admin_read ON public.profiles;
-- NOTE: the EXISTS subquery references `profiles` from within a policy on
-- `profiles`. This is safe — Postgres applies RLS to the subquery against
-- the caller's auth.uid() (not the row being checked), so it resolves in
-- O(1) without recursion. If you ever JOIN or add a row-level predicate
-- to this policy, re-test for recursion.
CREATE POLICY profiles_admin_read ON public.profiles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.is_admin = TRUE
    )
  );

-- No anon/authenticated INSERT/UPDATE/DELETE — service-role only via auth/callback.

-- ============================================================
-- view_as_audit table — append-only audit log for admin impersonation
-- ============================================================
CREATE TABLE IF NOT EXISTS public.view_as_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_email TEXT NOT NULL,
  target_sf_user_id TEXT NOT NULL,
  target_label TEXT,           -- display name at time of impersonation
  action TEXT NOT NULL DEFAULT 'view',  -- 'view' | future: 'order_materials' | 'send_email'
  path TEXT,                   -- the URL path where impersonation was active
  user_agent TEXT,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS view_as_audit_admin_idx ON public.view_as_audit (admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS view_as_audit_target_idx ON public.view_as_audit (target_sf_user_id, created_at DESC);

ALTER TABLE public.view_as_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS view_as_audit_admin_read ON public.view_as_audit;
CREATE POLICY view_as_audit_admin_read ON public.view_as_audit
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.is_admin = TRUE
    )
  );

-- ============================================================
-- updated_at auto-touch trigger on profiles
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_touch_updated_at ON public.profiles;
CREATE TRIGGER profiles_touch_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_profiles_updated_at();

-- Done.
