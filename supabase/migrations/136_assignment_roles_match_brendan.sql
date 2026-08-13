-- 136 · The role CHECK constraints never learned Brendan's four roles
--
-- Karan, 2026-08-13, adding Test Partner to Devin's Contracting:
--   "new row for relation commercial_account_assignments violates check
--    constraint commercial_account_assignments_role"
--
-- Brendan (2026-08-12): "Team Roles should be simple. PPP Staff roles: Sales
-- Rep, Field Rep, Office Rep, Estimator." The app was changed to offer exactly
-- those four. The DATABASE was never told.
--
--   commercial_account_assignments allows:
--     sales_rep · account_manager · primary_pm · superintendent · foreman
--     · billing_contact · other
--   commercial_opportunity_assignments allows:
--     sales_rep · lead_estimator · primary_pm · superintendent · other
--
-- Only `sales_rep` overlaps. So picking Field Rep, Office Rep or Estimator —
-- three of the four roles on offer — has failed with a raw Postgres error
-- since the day those roles shipped. The picker offered them and the database
-- refused them.
--
-- This is the "one list in two places" failure with Postgres as the second
-- place, which is the version a type-check cannot catch: the app constant and
-- the CHECK constraint are the same list, maintained separately.
--
-- Widened, not replaced. Every retired role stays permitted so existing rows
-- keep validating — `assignmentRoleLabel` still labels them, they are simply no
-- longer offered. Dropping them would break rows nobody asked us to touch.

ALTER TABLE public.commercial_account_assignments
  DROP CONSTRAINT IF EXISTS commercial_account_assignments_role_check;
ALTER TABLE public.commercial_account_assignments
  ADD CONSTRAINT commercial_account_assignments_role_check
  CHECK (role IN (
    -- Brendan's four, the only ones the UI offers.
    'sales_rep', 'field_rep', 'office_rep', 'estimator',
    -- Retired, kept so existing assignments still validate.
    'account_manager', 'primary_pm', 'superintendent', 'foreman',
    'billing_contact', 'lead_estimator', 'other'
  ));

ALTER TABLE public.commercial_opportunity_assignments
  DROP CONSTRAINT IF EXISTS commercial_opportunity_assignments_role_check;
ALTER TABLE public.commercial_opportunity_assignments
  ADD CONSTRAINT commercial_opportunity_assignments_role_check
  CHECK (role IN (
    'sales_rep', 'field_rep', 'office_rep', 'estimator',
    'account_manager', 'primary_pm', 'superintendent', 'foreman',
    'billing_contact', 'lead_estimator', 'other'
  ));

COMMENT ON CONSTRAINT commercial_account_assignments_role_check
  ON public.commercial_account_assignments IS
  'Must stay in step with ASSIGNMENT_ROLES in lib/commercial/accounts/assignment-roles.ts
   plus RETIRED_ROLE_LABELS. Changing the app list without changing this one
   produces a raw Postgres error in the UI (migration 136).';

-- ── Post-flight ───────────────────────────────────────────────────────────
-- Both should succeed and roll back cleanly:
--
--   BEGIN;
--   INSERT INTO commercial_account_assignments (account_id, user_id, role)
--   SELECT id, gen_random_uuid(), 'estimator' FROM commercial_accounts LIMIT 1;
--   ROLLBACK;
--
-- And every role already stored must still be permitted (expect 0 rows):
--   SELECT DISTINCT role FROM commercial_account_assignments
--    WHERE role NOT IN ('sales_rep','field_rep','office_rep','estimator',
--                       'account_manager','primary_pm','superintendent',
--                       'foreman','billing_contact','lead_estimator','other');
