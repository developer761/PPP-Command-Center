-- 123: Work Orders — select scope from the proposal, and allow several per project.
--
-- Karan 2026-08 meeting: "Multiple work orders per project just means we can
-- select items from a proposal to put into one work order." So a project's
-- proposal scope gets DIVIDED across work orders — each crew gets a sheet
-- listing only their items — and anything nobody has been given yet shows as
-- unassigned so it can't be quietly dropped.
--
-- Two changes:
--
--   1. `scope_line_item_ids` — which proposal line items this WO covers.
--      Stored as an array rather than a join table on purpose: the only
--      queries we need are "what's on this WO" (read the array) and "what's on
--      NO WO" (union the arrays for the deal, subtract from the proposal's
--      items). Both are per-deal and tiny. A join table would buy referential
--      integrity we don't want anyway — a line item deleted from the proposal
--      should leave the WO's other items intact, not cascade.
--
--      EMPTY ARRAY MEANS "EVERYTHING". Every work order that exists today has
--      no selection and prints the whole proposal, and that must keep working
--      untouched — so empty is the backward-compatible "all scope" default,
--      not "no scope". The app writes an explicit selection only when the user
--      picks one.
--
--   2. `area_label` — an optional free-text tag ("Level 3", "East wing",
--      "Punch list") for when the division is geographic rather than by trade.
--      Prints on the crew's sheet next to the WO number.
--
-- And it drops the one-live-work-order-per-opportunity unique index from
-- migration 106, which is precisely what blocked several. NOTE: this does NOT
-- touch migration 120's one-live-JOB-per-deal index. That's deliberate — a
-- work order is the paper a crew is handed, the Field Ops job is the deal's
-- schedulable unit, and splitting scope across three sheets doesn't make it
-- three separately-scheduled jobs. Crew assignments already say who works
-- when. If per-deal phases are ever built, 120 is the index to revisit.

alter table public.commercial_work_orders
  add column if not exists scope_line_item_ids uuid[] not null default '{}',
  add column if not exists area_label text;

comment on column public.commercial_work_orders.scope_line_item_ids is
  'Proposal line items this work order covers. EMPTY = the whole proposal (the pre-selection default, and what every legacy row means).';
comment on column public.commercial_work_orders.area_label is
  'Optional area/phase tag shown on the crew sheet, e.g. "Level 3" or "East wing".';

-- Allow several live work orders per opportunity (see the note above).
drop index if exists public.commercial_work_orders_one_live_per_opp;

-- Still want fast per-deal lookups now that there can be many.
create index if not exists commercial_work_orders_opp_live_idx
  on public.commercial_work_orders (opportunity_id)
  where voided_at is null;
