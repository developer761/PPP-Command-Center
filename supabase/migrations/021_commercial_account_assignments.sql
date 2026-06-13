-- Migration 021: Phase 1 — PPP staff assignments per Account.
--
-- Tracks which PPP staff member is working on each commercial Account, with
-- their role + whether they're the primary holder of that role. Drives the
-- Team tab + counts in the Account 360 overview.
--
-- Identity is the Supabase `profiles.user_id` (= auth.users.id), NOT the
-- Salesforce User Id. Karan 2026-06-13: Commercial CC is its own platform —
-- staff identity comes from our login system, not from SF.
--
-- Soft delete via `removed_at` (a staffer leaving the account isn't a hard
-- DELETE; we want the audit history).
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.commercial_account_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE CASCADE,
  -- profiles.user_id maps to auth.users.id (same column in two tables).
  -- Cascade on delete: if the auth user is removed, drop the assignment.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN (
    'sales_rep',
    'account_manager',
    'primary_pm',
    'superintendent',
    'foreman',
    'billing_contact',
    'other'
  )),
  -- "THE" sales rep / "THE" PM. UI shows one per role per account with this
  -- flag set. Multiple primaries in the same role on the same account is
  -- avoided by the partial unique index below.
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Soft delete — staffer is no longer working on this account. Audit
  -- history of who-worked-on-what stays queryable.
  removed_at TIMESTAMPTZ,
  removed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- A staffer can hold multiple roles on the same account (e.g. PM + Sales
  -- Rep on a small project). One row per (account, user, role).
  UNIQUE (account_id, user_id, role)
);

-- Hot path: "show me the CURRENT team for this account."
CREATE INDEX IF NOT EXISTS commercial_account_assignments_account_active_idx
  ON public.commercial_account_assignments (account_id)
  WHERE removed_at IS NULL;

-- Reverse lookup: "show me every account this user is assigned to."
CREATE INDEX IF NOT EXISTS commercial_account_assignments_user_active_idx
  ON public.commercial_account_assignments (user_id)
  WHERE removed_at IS NULL;

-- Primary holders — at most one is_primary=TRUE per (account, role) at a
-- time. Partial unique index lets the same (account, role) have one
-- primary live PLUS any number of removed rows in history.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_account_assignments_primary_idx
  ON public.commercial_account_assignments (account_id, role)
  WHERE is_primary = TRUE AND removed_at IS NULL;
