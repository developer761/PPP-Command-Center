-- 125: link a field-ops employee to a Commercial login (crew self-service).
--
-- RECORDED AFTER THE FACT. Karan applied this DDL directly from the crew-role
-- build spec (docs/CREW_ROLE_BUILD_SPEC_2026_08.md §2) before the file existed
-- in the repo, so the database was ahead of source control. Committing it keeps
-- the schema reproducible — a fresh environment built from migrations alone
-- would otherwise be missing the column and the crew feature would fail with a
-- 42703 that looks like a code bug.
--
-- Idempotent, so re-running against Karan's instance is a no-op.
--
-- Nullable: most employees never get a login. A login is optional and set by an
-- admin in Settings → Access when granting the crew role.
alter table public.commercial_employees
  add column if not exists user_id uuid;

-- At most ONE employee per login (a login is one person). Partial unique so the
-- many NULLs don't collide. Deliberately NOT a hard FK to auth.users — this
-- codebase keys to auth user ids by convention elsewhere
-- (commercial_user_roles.user_id) and avoids cross-schema FKs; match that.
create unique index if not exists commercial_employees_user_id_key
  on public.commercial_employees (user_id)
  where user_id is not null;

comment on column public.commercial_employees.user_id is
  'Commercial login this employee signs in as (crew self-service). NULL for the majority who have no login. Resolved via getEmployeeForUser, which falls back to an email match when unset.';
