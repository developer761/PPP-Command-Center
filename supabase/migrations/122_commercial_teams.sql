-- 122: Teams — reusable named groups of staff (a name + a team admin + members
-- with roles), assignable to accounts/opportunities by NAME (Karan meeting
-- 2026-08: "add a Team rather than individual team members"). Mirrors the
-- commercial_account_assignments identity model (user_id = auth.users.id = the
-- Supabase profiles.user_id) + role enum. Idempotent.

create table if not exists public.commercial_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.commercial_team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.commercial_teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'other' check (role in (
    'sales_rep','account_manager','primary_pm','superintendent','foreman','billing_contact','other'
  )),
  is_team_admin boolean not null default false,
  created_at timestamptz not null default now(),
  removed_at timestamptz
);

-- One live membership per (team, user).
create unique index if not exists commercial_team_members_team_user_uq
  on public.commercial_team_members (team_id, user_id) where removed_at is null;
create index if not exists commercial_team_members_team_idx
  on public.commercial_team_members (team_id) where removed_at is null;

-- Which team is assigned to an account (by name; members derive from the team).
alter table public.commercial_accounts
  add column if not exists team_id uuid references public.commercial_teams(id) on delete set null;
-- ...and to an opportunity (a deal can carry its own team, distinct from the GC).
alter table public.commercial_opportunities
  add column if not exists team_id uuid references public.commercial_teams(id) on delete set null;
