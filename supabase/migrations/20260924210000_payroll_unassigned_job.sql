-- Where a week's non-job hours get charged.
--
-- Mary, 2026-09-24, asked whether hours that are not on a job — vacation, shop
-- time — should be excluded from the split or spread across the jobs:
--
--   "Included. Like if Greg takes a vacation BD had me put it against a job."
--
-- And on how that job is chosen:
--
--   "I would say he picks a job that can handle the expense."
--
-- So it is neither excluded nor spread. It goes on ONE job, and which job is a
-- judgement somebody makes each week — not a rule the platform can derive. A
-- person weighing whether a job can carry the cost is doing something the data
-- does not contain.
--
-- Spreading it pro-rata, which is what the first version did, is wrong in a
-- specific and invisible way: a week where Greg worked three jobs would put a
-- third of his vacation on each, and every one of those jobs would read
-- slightly dearer than Brendan intended, with nothing on any screen saying a
-- decision had been made on his behalf.
--
-- Nullable on purpose. A week with no unassigned hours never needs it, and a
-- week that HAS them and has not been told where they go is blocked rather
-- than guessed at.

alter table public.commercial_payroll_costs
  add column if not exists unassigned_opportunity_id uuid
    references public.commercial_opportunities (id) on delete set null;

comment on column public.commercial_payroll_costs.unassigned_opportunity_id is
  'The job this employee''s non-job hours (vacation, shop time) are charged to for this week. Chosen by a person — Mary 2026-09-24: "he picks a job that can handle the expense." Null while the choice has not been made, which blocks the week from posting.';

-- And the cost itself becomes nullable.
--
-- A row now exists for two reasons: a Gusto cost has been entered, OR the job
-- for somebody's non-job hours has been chosen. Those happen in either order,
-- so the row has to be able to hold one without the other.
--
-- `not null` forced a blank cost to be stored as 0, and 0 is a real figure:
-- it would satisfy "a cost has been entered", clear the blocker, and let the
-- week post with that person costed at nothing — putting every job they
-- touched quietly into profit. A blank means NOT ENTERED YET and has to be
-- storable as such.
alter table public.commercial_payroll_costs
  alter column actual_cost_cents drop not null;

comment on column public.commercial_payroll_costs.actual_cost_cents is
  'Company liability from Gusto — wages + payroll taxes. NULL means not entered yet, which blocks the week; 0 would mean genuinely nothing, which does not.';
