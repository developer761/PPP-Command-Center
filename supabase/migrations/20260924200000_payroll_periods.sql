-- Weekly payroll, and the job-cost split that comes out of it.
--
-- Katie 2026-09-24, describing what Mary does by hand every Thursday:
--
--   "Mary takes the actual company liability which is their payroll + payroll
--    taxes (ex: JJ gets paid 500 but gusto actually takes out $520 from the
--    bank, $20 is the payroll tax). Mary looks at the attendance report with
--    the % split and calculates how much of their weekly payroll is attributed
--    to each job based on the hours they worked there... The calculated value
--    is the Payout for that work for that job."
--
--   "The less complicated that we can make Mary's job, the better. Right now
--    the calculations are manual."
--
-- Two tables, and deliberately no third.
--
-- WHAT IS NOT HERE: a table of allocated job costs. The split becomes rows in
-- commercial_project_purchases — the payout record the platform already keeps
-- for every sub — because Katie's own sentence says the calculated value IS
-- the payout. Job costs, the Labor payments view, the P&L and the Salesforce
-- reconcile all read that table today, so a second home for the same money
-- would be a second truth to keep in step.

create table if not exists public.commercial_payroll_periods (
  id           uuid primary key default gen_random_uuid(),
  -- Monday and Sunday. Overtime is a whole-week idea (40h), so a period that
  -- is not a whole week cannot be costed correctly, and the payroll export
  -- already snaps its range outward for the same reason.
  start_date   date not null,
  end_date     date not null,
  status       text not null default 'draft'
                 check (status in ('draft', 'allocated')),
  notes        text,
  allocated_at timestamptz,
  allocated_by_user_id uuid references public.profiles (user_id) on delete set null,
  created_by_user_id   uuid references public.profiles (user_id) on delete set null,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One live period per week. Partial, so a deleted one releases its week —
-- the lesson from Stephanie's AIA numbering the same morning.
create unique index if not exists commercial_payroll_periods_live_week_uidx
  on public.commercial_payroll_periods (start_date)
  where deleted_at is null;

comment on table public.commercial_payroll_periods is
  'One payroll week. Mary enters each W-2 employee''s actual company cost from Gusto, and the platform splits it across the jobs they worked. 2026-09-24.';

create table if not exists public.commercial_payroll_costs (
  id             uuid primary key default gen_random_uuid(),
  period_id      uuid not null
                   references public.commercial_payroll_periods (id) on delete cascade,
  employee_id    uuid not null
                   references public.commercial_employees (id) on delete cascade,
  -- What Gusto actually took out of the bank for this person: wages PLUS
  -- payroll taxes. The burden is already inside it, which is why no hourly
  -- rate is involved in costing a job.
  actual_cost_cents bigint not null check (actual_cost_cents >= 0),
  -- The pre-Gusto gross, kept only so the screen can show the two side by side
  -- and Mary can see the tax at a glance. Nothing is costed from it.
  gross_cents    bigint check (gross_cents >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One cost per person per week.
create unique index if not exists commercial_payroll_costs_period_employee_uidx
  on public.commercial_payroll_costs (period_id, employee_id);

comment on column public.commercial_payroll_costs.actual_cost_cents is
  'Company liability from Gusto — wages + payroll taxes. The figure that gets split across jobs by hours.';

-- The link back from an allocated payout to the week that produced it.
--
-- Without it, re-running a week after Mary corrects a Gusto figure would add a
-- second set of payouts on top of the first and double every job. With it, the
-- previous run's rows are found and replaced.
alter table public.commercial_project_purchases
  add column if not exists payroll_period_id uuid
    references public.commercial_payroll_periods (id) on delete set null;

create index if not exists commercial_project_purchases_payroll_period_idx
  on public.commercial_project_purchases (payroll_period_id)
  where payroll_period_id is not null and deleted_at is null;

comment on column public.commercial_project_purchases.payroll_period_id is
  'Set when this labor payout was produced by splitting a payroll week. Lets a re-run replace its own rows instead of duplicating them. 2026-09-24.';

alter table public.commercial_payroll_periods enable row level security;
alter table public.commercial_payroll_costs   enable row level security;
