-- 124: add the 'crew' role.
--
-- Karan 2026-08: a crew member logs in and sees ONLY their own work orders,
-- schedule, hours and clock. The team is trusted, so the PIN kiosk opens to
-- them rather than staying admin-only.
--
-- Unlike every other value in this enum, `crew` RESTRICTS rather than grants.
-- Commercial access has been binary (have it, see everything), so a crew login
-- is a normal user whose reachable routes are confined by an ALLOWLIST in
-- lib/commercial/crew-access.ts. Holding `crew` AND any other role lifts the
-- restriction — that's deliberate, so adding someone to a second role can
-- never accidentally trap them, and an admin can't lock themselves out.
--
-- The CHECK constraint from migration 019 has to be widened or the insert
-- fails with 23514.

alter table public.commercial_user_roles
  drop constraint if exists commercial_user_roles_role_check;

alter table public.commercial_user_roles
  add constraint commercial_user_roles_role_check
  check (role in ('admin', 'estimator', 'pm', 'superintendent', 'foreman', 'office', 'field', 'crew'));

comment on column public.commercial_user_roles.role is
  'Commercial role. All values GRANT capability except ''crew'', which confines the login to the field-ops allowlist in lib/commercial/crew-access.ts.';
