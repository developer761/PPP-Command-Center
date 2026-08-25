-- 156 — capture room measurements from whatever source is to hand.
--
-- THE PROBLEM, measured against the live org on 2026-08-25:
--   457 open work orders have line items.
--   353 of them (77%) have NO measurement on ANY line — not square footage,
--   not wall area, not perimeter. 82% need some manual entry.
-- The gallon estimator can't size those, so the materials tool asks the vendor
-- to "confirm quantity" on most real jobs, which is close to useless.
--
-- Interestingly the same query over ALL line items ever shows 87% measured.
-- Old jobs get their numbers eventually; jobs being ordered RIGHT NOW don't.
-- So this is a capture-timing problem, not an ability problem — which is why
-- the answer is to make capture take seconds, from wherever the person is.
--
-- DESIGN: extend the table the estimator ALREADY reads rather than adding a
-- parallel one. `sqft` keeps its exact meaning (floor area), so every existing
-- consumer — the order builder, the supplier email, the work-order page — picks
-- these up with no code change at all. The new columns are additive detail.
alter table public.wo_li_sqft_overrides
  add column if not exists length_ft   numeric(7,2),
  add column if not exists width_ft    numeric(7,2),
  add column if not exists ceiling_ft  numeric(5,2),
  -- Real perimeter when length+width are known. The estimator otherwise
  -- guesses 4×√area, which assumes a square room and runs 25% low on a
  -- 24×6 hallway — a shape PPP paints constantly.
  add column if not exists perimeter_lf numeric(8,2),
  add column if not exists source      text,
  add column if not exists confidence  text;

comment on column public.wo_li_sqft_overrides.source is
  'How the number was obtained: dimensions | photo | address | history | manual. Drives the confidence badge and the training loop.';
comment on column public.wo_li_sqft_overrides.confidence is
  'high = someone measured it · medium = derived from a photo or comparable jobs · low = distributed from whole-house records.';
comment on column public.wo_li_sqft_overrides.perimeter_lf is
  'Real perimeter 2(L+W). Beats the estimator''s square-room fallback.';

-- Every capture attempt, including ones nobody accepted.
--
-- This is the training loop. A photo estimate that a worker then corrected by
-- 40% is the most valuable row in the system: it says the vision prompt is
-- wrong for that kind of room, and it can only be learned if the rejected
-- value was kept alongside the accepted one.
create table if not exists public.room_measurement_captures (
  id                uuid primary key default gen_random_uuid(),
  woli_id           text not null,
  work_order_id     text,
  room_label        text,
  source            text not null,
  -- What the source proposed.
  suggested_sqft    integer,
  suggested_length_ft numeric(7,2),
  suggested_width_ft  numeric(7,2),
  confidence        text,
  -- What the human actually kept. Null while a suggestion is still unreviewed.
  accepted_sqft     integer,
  accepted          boolean,
  -- Provider payload / model reasoning / property record, for auditing a
  -- number that later looks wrong.
  detail            jsonb,
  captured_by       text,
  created_at        timestamptz not null default now()
);

create index if not exists room_measurement_captures_woli_idx
  on public.room_measurement_captures (woli_id);
create index if not exists room_measurement_captures_source_idx
  on public.room_measurement_captures (source, created_at desc);

-- Service-role only, matching wo_li_sqft_overrides. Every read/write goes
-- through an API route that gates on the viewer's capabilities.
alter table public.room_measurement_captures enable row level security;

comment on table public.room_measurement_captures is
  'Every measurement suggestion and what the human did with it. Feeds accuracy tuning: a suggestion corrected by 40% is the signal that the method is wrong for that room type.';
