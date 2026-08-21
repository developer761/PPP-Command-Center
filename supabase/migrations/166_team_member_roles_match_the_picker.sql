-- 166 · Migration 136 fixed two of the three tables. This is the third.
--
-- Stephanie, 2026-08-20: "I can't add team members, which may be why no
-- notifications for approval are coming through via email."
--
-- Verified against the live database on 2026-08-21: inserting the role the
-- picker offers fails outright —
--
--   insert commercial_team_members (role => 'estimator')
--   ERROR: new row for relation "commercial_team_members" violates check
--          constraint "commercial_team_members_role_check"
--
-- ...and commercial_team_members holds ZERO rows, which is what you would
-- expect from a form nobody has ever managed to submit.
--
-- SAME BUG AS 136, ONE TABLE FURTHER ALONG. Settings -> Teams builds its role
-- dropdown from ASSIGNMENT_ROLES — Brendan's four: Sales Rep, Field Rep,
-- Office Rep, Estimator. This table's CHECK still carries the ORIGINAL seven
-- from migration 122: sales_rep, account_manager, primary_pm, superintendent,
-- foreman, billing_contact, other.
--
-- Only `sales_rep` overlaps. So three of the four roles on offer have been
-- refused by Postgres since the day those roles shipped — and "Estimator" is
-- the one you would reach for first when adding Brendan or Kim.
--
-- 136 widened commercial_account_assignments and
-- commercial_opportunity_assignments and stopped there. The team roster uses
-- the same constant and was left behind, which is precisely the failure mode
-- 136's own comment describes: one list in two places, with Postgres as the
-- copy a type-check cannot see. Three places, as it turns out.
--
-- Widened, not replaced — same as 136. Every original role stays permitted so
-- any row written before this keeps validating; they are simply no longer
-- offered.
--
-- NOTE ON HER SECOND CLAUSE: team membership is NOT what drives approval
-- emails. Those go to Proposal Approvers, set in Settings -> Access, and
-- Stephanie is already flagged as one with her notify email enabled. Her
-- missing approval emails are a deliverability problem, not this. Fixing this
-- makes the team roster work; it will not by itself make an email arrive.

ALTER TABLE public.commercial_team_members
  DROP CONSTRAINT IF EXISTS commercial_team_members_role_check;

ALTER TABLE public.commercial_team_members
  ADD CONSTRAINT commercial_team_members_role_check
  CHECK (role IN (
    -- Brendan's four — the only ones the UI offers.
    'sales_rep', 'field_rep', 'office_rep', 'estimator',
    -- Retired/original, kept so existing rows still validate.
    'account_manager', 'primary_pm', 'superintendent', 'foreman',
    'billing_contact', 'lead_estimator', 'other'
  ));

COMMENT ON CONSTRAINT commercial_team_members_role_check
  ON public.commercial_team_members IS
  'Must stay in step with ASSIGNMENT_ROLES in lib/commercial/accounts/assignment-roles.ts
   plus RETIRED_ROLE_LABELS. Changing the app list without changing this one
   produces a raw Postgres error in the UI (migrations 136, 166).';

-- ── Post-flight ───────────────────────────────────────────────────────────
-- Should succeed and roll back cleanly:
--
--   BEGIN;
--   INSERT INTO commercial_team_members (team_id, user_id, role)
--   SELECT t.id, p.user_id, 'estimator'
--     FROM commercial_teams t, profiles p LIMIT 1;
--   ROLLBACK;
--
-- And nothing already stored may fall outside the new list (expect 0 rows):
--   SELECT DISTINCT role FROM commercial_team_members
--    WHERE role NOT IN ('sales_rep','field_rep','office_rep','estimator',
--                       'account_manager','primary_pm','superintendent',
--                       'foreman','billing_contact','lead_estimator','other');
