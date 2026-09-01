-- 177_regional_manager_role.sql
--
-- Kate, 2026-09-01: "We have regional managers that should essentially have the
-- Sales Rep settings but with the ability to see all work orders."
--
-- profiles.role carries a CHECK constraint, so the application-side union in
-- lib/auth/roles.ts is only half the change: without this, provisioning a
-- regional manager fails at the database with a constraint violation, and the
-- Access screen shows an option that cannot be saved.
--
-- Additive only. Every existing value is preserved — including the four
-- Commercial roles added by migration 112 — so this cannot orphan a row on
-- either platform.

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in (
    -- Residential Command Center
    'admin',
    'account_manager',
    'regional_manager',
    'rep',
    -- Commercial Command Center (migration 112)
    'scheduler',
    'foreman',
    'payroll',
    'viewer'
  ));
