-- What came from Salesforce, and what it became here.
--
-- The Tomco migration imports ~5,000 records across a dozen tables. Re-running a
-- stage — because it half-failed, or because Salesforce changed and we pulled
-- again — must UPDATE what it wrote before, never duplicate it. Most of the
-- target tables have nowhere to put a Salesforce id (accounts, contacts,
-- purchases, work orders and jobs have no external-id column at all), and adding
-- one to each is eight schema changes for bookkeeping that belongs to the
-- migration rather than to the platform.
--
-- So: one table. `sf_id` is Salesforce's 18-character id, `entity` says what it
-- became, `row_id` is ours.
--
-- Wiped alongside the data it describes — a map pointing at deleted rows is
-- worse than no map.

create table if not exists public.commercial_import_map (
  sf_id       text not null,
  entity      text not null,
  row_id      uuid not null,
  imported_at timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  source      text not null default 'salesforce',
  notes       text,
  primary key (sf_id, entity)
);

create index if not exists commercial_import_map_entity_idx
  on public.commercial_import_map (entity);
-- Finding "what did this row come from?" from our side, e.g. when a number on
-- screen is queried and somebody asks which Salesforce record it was.
create index if not exists commercial_import_map_row_idx
  on public.commercial_import_map (row_id);

comment on table public.commercial_import_map is
  'Salesforce id -> imported row, so any import stage can be re-run without duplicating. Emptied by scripts/wipe-commercial-data.sql along with the data it maps.';

alter table public.commercial_import_map enable row level security;
