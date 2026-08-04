-- 112 · R10.0 — Field Ops / Scheduling foundation (the whole data model).
--
-- Crew scheduling → labor tracking → payroll. Clean start, no historical import.
-- Principles baked in: IDs are keys (never names) · scheduled ≠ actual (separate
-- tables) · crews are templates (assignments hold hours, crews don't) · job_code
-- mandatory · pay rates isolated in their own gated table.
--
-- App-layer audit (logInsert/logUpdate) covers the payroll-adjacent tables
-- (time_entries, time_punches, assignments, employee_rates) — no new audit table.

-- ── Roles: expand the profiles CHECK (adds field-ops roles + the deferred viewer)
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','account_manager','rep','scheduler','foreman','payroll','viewer'));

-- ── Employees (the crew master) ────────────────────────────────────────────
create table if not exists public.commercial_employees (
  id                    uuid primary key default gen_random_uuid(),
  first_name            text not null,
  last_name             text,
  display_name          text not null,                 -- "Rob C" / "Rob P." (disambiguated)
  worker_type           text not null default 'w2' check (worker_type in ('w2','sub','temp')),
  role                  text not null default 'painter' check (role in ('foreman','painter','taper','laborer','apprentice')),
  pay_type              text not null default 'hourly' check (pay_type in ('hourly','daily','salary')),
  default_daily_hours   numeric(4,1) not null default 8,
  phone                 text,
  email                 text,
  sort_order            integer not null default 0,     -- stable Week-Grid column order
  active                boolean not null default true,  -- never delete; deactivate
  start_date            date,
  end_date              date,
  schedule_email_opt_out boolean not null default false, -- everyone emailed unless opted out
  preferred_language    text not null default 'en' check (preferred_language in ('en','es')),
  clock_pin_hash        text,                            -- 4-digit PIN (hashed) for the Clock Station
  magic_link_token      text unique,                     -- rotating token for personal schedule + clock link
  external_ref          text,                            -- future Gusto/payroll id
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists commercial_employees_active_sort_idx on public.commercial_employees (active, sort_order);
create index if not exists commercial_employees_token_idx on public.commercial_employees (magic_link_token);

-- ── Employee rates (RESTRICTED — Admin + Payroll only, app-gated) ───────────
create table if not exists public.commercial_employee_rates (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.commercial_employees(id) on delete cascade,
  cost_rate_cents integer not null,                     -- burdened cost/hr or /day
  rate_type      text not null default 'hourly' check (rate_type in ('hourly','daily')),
  effective_from date not null,
  effective_to   date,
  created_at     timestamptz not null default now()
);
create index if not exists commercial_employee_rates_emp_idx on public.commercial_employee_rates (employee_id, effective_from desc);

-- ── Crews (templates) + members (historical membership) ─────────────────────
create table if not exists public.commercial_crews (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  foreman_employee_id uuid references public.commercial_employees(id),
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);
create table if not exists public.commercial_crew_members (
  id          uuid primary key default gen_random_uuid(),
  crew_id     uuid not null references public.commercial_crews(id) on delete cascade,
  employee_id uuid not null references public.commercial_employees(id) on delete cascade,
  added_at    timestamptz not null default now(),
  removed_at  timestamptz
);
create index if not exists commercial_crew_members_crew_idx on public.commercial_crew_members (crew_id) where removed_at is null;

-- ── Jobs (schedulable; standalone-first, optional deal/WO link) ─────────────
create table if not exists public.commercial_jobs (
  id                    uuid primary key default gen_random_uuid(),
  job_code              text not null unique,           -- MANDATORY at creation
  name                  text not null,
  opportunity_id        uuid references public.commercial_opportunities(id),  -- nullable: backed by a won deal
  work_order_id         uuid references public.commercial_work_orders(id),    -- nullable: backed by a WO
  account_id            uuid references public.commercial_accounts(id),
  customer_name         text,                            -- free-text for PPP/misc jobs not in the pipeline
  site_address          text,
  site_city             text,
  site_state            text,
  site_zip              text,
  lat                   numeric(9,6),
  lng                   numeric(9,6),
  status                text not null default 'ready_to_schedule'
                          check (status in ('estimating','ready_to_schedule','scheduled','in_progress','complete','closed','on_hold')),
  estimated_labor_hours numeric(8,1),
  target_start          date,
  target_end            date,
  prevailing_wage       boolean not null default false,  -- "PW" jobs
  division_tag          text,                            -- 'ppp' | 'commercial' | 'other' (the "(ppp job)" reality)
  notes                 text,
  created_by_user_id    uuid,
  deleted_at            timestamptz,                     -- soft-delete (platform consistency); reports/pickers filter it out
  deleted_by_user_id    uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists commercial_jobs_status_idx on public.commercial_jobs (status) where deleted_at is null;
create index if not exists commercial_jobs_opp_idx on public.commercial_jobs (opportunity_id);
create index if not exists commercial_jobs_wo_idx on public.commercial_jobs (work_order_id);

-- ── Job phases (Karan: multiple date ranges per job) ────────────────────────
create table if not exists public.commercial_job_phases (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.commercial_jobs(id) on delete cascade,
  phase_no   integer not null,
  label      text,
  start_date date,
  end_date   date,
  created_at timestamptz not null default now(),
  unique (job_id, phase_no)
);

-- ── Assignments (THE SCHEDULE — what SHOULD happen) ─────────────────────────
create table if not exists public.commercial_assignments (
  id                   uuid primary key default gen_random_uuid(),
  job_id               uuid not null references public.commercial_jobs(id) on delete cascade,
  employee_id          uuid not null references public.commercial_employees(id) on delete cascade,
  work_date            date not null,
  scheduled_hours      numeric(4,1) not null default 8,
  scheduled_start_time time,                             -- for 2-jobs-a-day windows (Job A 7–11, Job B 12–4)
  crew_id              uuid references public.commercial_crews(id),  -- provenance only; crews never hold hours
  status               text not null default 'planned' check (status in ('planned','published','cancelled')),
  note                 text,
  created_by_user_id   uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (job_id, employee_id, work_date)               -- one row per job/person/day; 2 jobs/day = 2 rows
);
create index if not exists commercial_assignments_date_idx on public.commercial_assignments (work_date);
create index if not exists commercial_assignments_emp_date_idx on public.commercial_assignments (employee_id, work_date);
create index if not exists commercial_assignments_job_idx on public.commercial_assignments (job_id);

-- ── Absences ────────────────────────────────────────────────────────────────
create table if not exists public.commercial_absences (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.commercial_employees(id) on delete cascade,
  work_date   date not null,
  type        text not null check (type in ('PTO','SICK','PERSONAL','HOLIDAY','NO_WORK','NOT_AVAILABLE')),
  hours       numeric(4,1),                              -- null = full day
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists commercial_absences_emp_date_idx on public.commercial_absences (employee_id, work_date);

-- ── Pay periods ─────────────────────────────────────────────────────────────
create table if not exists public.commercial_pay_periods (
  id          uuid primary key default gen_random_uuid(),
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'open' check (status in ('open','review','exported','closed')),
  exported_at timestamptz,
  exported_by_user_id uuid,
  created_at  timestamptz not null default now()
);

-- ── Time entries (ACTUALS — daily aggregate, the approved/exported unit) ─────
create table if not exists public.commercial_time_entries (
  id              uuid primary key default gen_random_uuid(),
  assignment_id   uuid references public.commercial_assignments(id) on delete set null,  -- null = unplanned
  job_id          uuid not null references public.commercial_jobs(id) on delete cascade,
  employee_id     uuid not null references public.commercial_employees(id) on delete cascade,
  work_date       date not null,
  actual_hours    numeric(4,1) not null default 0,       -- Σ punches, or manual
  source          text not null default 'manual' check (source in ('clocked','manual')),
  status          text not null default 'submitted' check (status in ('submitted','questioned','approved','exported')),
  pay_period_id   uuid references public.commercial_pay_periods(id),
  questioned_reason text,
  submitted_by_user_id uuid,
  submitted_at    timestamptz,
  approved_by_user_id  uuid,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (employee_id, job_id, work_date)
);
create index if not exists commercial_time_entries_period_idx on public.commercial_time_entries (pay_period_id, status);
create index if not exists commercial_time_entries_emp_date_idx on public.commercial_time_entries (employee_id, work_date);

-- ── Time punches (CLOCK IN/OUT — raw events, sum into time_entries) ──────────
create table if not exists public.commercial_time_punches (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.commercial_employees(id) on delete cascade,
  job_id        uuid not null references public.commercial_jobs(id) on delete cascade,
  assignment_id uuid references public.commercial_assignments(id) on delete set null,
  clock_in_at   timestamptz not null,                    -- SERVER clock, never the phone
  clock_out_at  timestamptz,                             -- null while on the clock
  source        text not null default 'self_link' check (source in ('self_link','kiosk','foreman','admin')),
  edited_by_user_id uuid,
  edited_at     timestamptz,
  note          text,
  created_at    timestamptz not null default now()
);
-- At most ONE open punch per employee (can't be clocked into two things at once).
create unique index if not exists commercial_time_punches_one_open_idx
  on public.commercial_time_punches (employee_id) where clock_out_at is null;
create index if not exists commercial_time_punches_emp_idx on public.commercial_time_punches (employee_id, clock_in_at desc);
create index if not exists commercial_time_punches_job_idx on public.commercial_time_punches (job_id);

-- ── Internal schedule-email recipients (office: Stephanie/Brendan/…) ─────────
create table if not exists public.commercial_schedule_email_recipients (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  label      text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
