-- 146 — the follow-up date lives in the Command Center too.
--
-- Kate round-3 #13: "Setting a follow-up date in the filter returns zero
-- results, on any date."
--
-- Round 2 shipped the follow-up date as a Salesforce-only field
-- (WorkOrder.FollowupDate__c), written straight through and read straight back.
-- The data dictionary lists BOTH casings for it, the code probes one then the
-- other, and when neither resolves the read fails to an empty map with nothing
-- but a console warning. The Mail Hub then filters on a value that is null for
-- every row — which looks exactly like "the filter is broken".
--
-- This is the same shape as the square-footage problem in round 2 (#17): a
-- Command Center feature depending on a Salesforce field whose availability we
-- don't control. Same resolution: the Command Center keeps its own copy and
-- still pushes to Salesforce. Filtering, sorting and display read the local
-- value; Salesforce stays in sync when the field is there; and if the push
-- fails, it now says so instead of quietly doing nothing.
--
-- One row per work order — a follow-up date is a property of the job, not of
-- any particular email or token.

create table if not exists public.wo_followup_dates (
  work_order_id  text primary key,
  followup_date  date not null,
  updated_by     uuid,
  updated_at     timestamptz not null default now()
);

create index if not exists wo_followup_dates_date_idx
  on public.wo_followup_dates (followup_date);

alter table public.wo_followup_dates enable row level security;

-- Server-side only, via the admin client in /api/dashboard/materials/followup
-- (gated on canEnterColors) and the Mail Hub feed. No client-facing policy,
-- matching wo_li_sqft_overrides.
drop policy if exists wo_followup_dates_no_client on public.wo_followup_dates;

comment on table public.wo_followup_dates is
  'Command Center copy of each work order''s follow-up date. Authoritative for Command Center filtering/display; also pushed to Salesforce WorkOrder.FollowupDate__c. Kate round-3 #13.';
