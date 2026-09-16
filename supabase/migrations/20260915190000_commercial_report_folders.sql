-- Commercial report folders (Katie 2026-09-15).
--
-- "Report folders with ability to give access to certain users to each folder.
-- The reports live inside the folders. So we will need a folder for Manager,
-- Field Users, Finance, etc."
--
-- The rule the app enforces (lib/commercial/reports/access-rule.ts):
--   * admins see every report;
--   * everyone else sees exactly the reports in SHARED folders they are an
--     active member of (removed_at is null, folder not deleted);
--   * a PERSONAL folder (owner_user_id set) is just an organised view for its
--     owner and never grants access;
--   * the existing role gates still apply on top (the estimator report stays
--     admin / account manager only).
--
-- IMPORTANT: until this is applied, non-admin Commercial users see no reports
-- (the lookup fails closed). Admins are unaffected.
--
-- Three tables, service-role only (RLS on, no policies) like every other
-- commercial_* table — every read and write goes through the server.
--
-- Idempotent: safe to re-run. The seed only fills a folder the FIRST time it is
-- created (fixed ids + on conflict do nothing), so re-running never re-adds a
-- report or a person Katie has since removed, and never undoes a rename.

create table if not exists public.commercial_report_folders (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (length(btrim(name)) between 1 and 80),
  description         text check (description is null or length(description) <= 280),
  icon                text not null default 'folder' check (icon in ('folder','briefcase','dollar','hardhat','chart','star')),
  sort_order          integer not null default 0,
  -- NULL = a shared folder an admin manages; set = someone's personal folder.
  owner_user_id       uuid references auth.users(id) on delete cascade,
  created_by_user_id  uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

create index if not exists commercial_report_folders_shared_idx
  on public.commercial_report_folders (sort_order) where deleted_at is null and owner_user_id is null;
create index if not exists commercial_report_folders_owner_idx
  on public.commercial_report_folders (owner_user_id, sort_order) where deleted_at is null;

create table if not exists public.commercial_report_folder_items (
  id          uuid primary key default gen_random_uuid(),
  folder_id   uuid not null references public.commercial_report_folders(id) on delete cascade,
  -- A key from lib/commercial/reports/registry.ts. Deliberately no enum CHECK:
  -- a new report must not need a migration, and the app ignores unknown keys.
  report_key  text not null check (report_key ~ '^[a-z0-9-]{1,40}$'),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (folder_id, report_key)
);

create index if not exists commercial_report_folder_items_folder_idx
  on public.commercial_report_folder_items (folder_id, sort_order);

create table if not exists public.commercial_report_folder_members (
  id                uuid primary key default gen_random_uuid(),
  folder_id         uuid not null references public.commercial_report_folders(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  added_by_user_id  uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  removed_at        timestamptz
);

-- One live membership per (folder, user); removed rows stay as history.
create unique index if not exists commercial_report_folder_members_live_uq
  on public.commercial_report_folder_members (folder_id, user_id) where removed_at is null;
create index if not exists commercial_report_folder_members_user_idx
  on public.commercial_report_folder_members (user_id) where removed_at is null;

alter table public.commercial_report_folders        enable row level security;
alter table public.commercial_report_folder_items   enable row level security;
alter table public.commercial_report_folder_members enable row level security;

-- ─── Seed: the three folders Katie named ────────────────────────────────────
--
-- DEFAULT report sets — a starting point, not a decision. Katie (or any admin)
-- changes them in Settings → Report folders.
--
--   Manager      every report
--   Finance      receivables, AR aging, cash flow, job costs, change orders,
--                labor, signatures
--   Field Users  pipeline, geography, win/loss, change orders, signatures
--
-- Members seeded by email where a login already exists:
--   Manager      alex@precisionpaintingplus.net
--   Field Users  brendan@tomcopainting.com, stephanie@tomcopainting.com,
--                jason.eng@precisionpaintingplus.net
--
-- Mary O'Sullivan (Finance) and Kelvi Polanco (Field Users) have no login yet —
-- add them in Settings → Report folders once their accounts exist. Jason's
-- Commercial access is currently OFF, so his membership does nothing until it
-- is turned on in Settings → Access & Users.
--
-- Note: Alex, Brendan and Stephanie are admins today, and admins see every
-- report regardless of folders. Their memberships record the intended grouping
-- and take effect if their role ever changes.

do $$
declare
  v_id uuid;
  f record;
  k text;
  i integer;
  e text;
begin
  for f in
    select * from (values
      ('6f1d3c2a-5b7e-4c1a-9d0e-000000000001'::uuid, 'Manager', 'Every report — the whole company at a glance.', 'briefcase', 10,
        array['pipeline','geography','estimator','signatures','win-loss','jobs','job-costs','labor','change-orders','cash-flow','receivables','ar-aging','balance-owed','pipeline-manager','scheduling','open-sales','purchases-by-vendor','labor-payments','reimbursements-out','deposit-history'],
        array['alex@precisionpaintingplus.net']),
      ('6f1d3c2a-5b7e-4c1a-9d0e-000000000002'::uuid, 'Finance', 'What is owed, what came in, and what the work cost.', 'dollar', 20,
        array['jobs','receivables','ar-aging','cash-flow','job-costs','change-orders','labor','signatures'],
        array[]::text[]),
      ('6f1d3c2a-5b7e-4c1a-9d0e-000000000003'::uuid, 'Field Users', 'Pipeline, where the work is, and how jobs are changing.', 'hardhat', 30,
        array['pipeline','geography','win-loss','change-orders','signatures'],
        array['brendan@tomcopainting.com','stephanie@tomcopainting.com','jason.eng@precisionpaintingplus.net'])
    ) as t(id, name, description, icon, sort_order, reports, emails)
  loop
    v_id := null;
    insert into public.commercial_report_folders (id, name, description, icon, sort_order, owner_user_id)
    values (f.id, f.name, f.description, f.icon, f.sort_order, null)
    on conflict (id) do nothing
    returning id into v_id;

    -- Already there from an earlier run: leave whatever Katie has done to it.
    continue when v_id is null;

    i := 0;
    foreach k in array f.reports loop
      i := i + 1;
      insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
      values (v_id, k, i * 10)
      on conflict (folder_id, report_key) do nothing;
    end loop;

    foreach e in array f.emails loop
      insert into public.commercial_report_folder_members (folder_id, user_id)
      select v_id, p.user_id
        from public.profiles p
        join auth.users u on u.id = p.user_id
       where lower(p.email) = lower(e)
      on conflict (folder_id, user_id) where removed_at is null do nothing;
    end loop;
  end loop;
end $$;
