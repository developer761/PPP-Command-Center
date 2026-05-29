-- 013_paint_coverage_config.sql
-- Tunable constants for the paint gallons calculator (Katie: "treat coverage
-- rate, buffer %, deduction/casing constants, trim width as named config —
-- PPP will tune them without changing the formulas").
--
-- Single-row table (key='default') holding the config as JSONB. The app reads
-- it via loadCoverageConfig(), which MERGES the stored values over the code
-- defaults (lib/supplier-order/estimate-gallons.ts COVERAGE_CONFIG) — so any
-- missing/new key falls back to the default, and a missing table / unreachable
-- DB simply uses the code defaults. Safe to deploy before this runs.
--
-- IF NOT EXISTS so re-running is a no-op (no migration runner — pasted by hand).

create table if not exists paint_coverage_config (
  key                 text primary key,
  config              jsonb not null default '{}'::jsonb,
  updated_at          timestamptz not null default now(),
  updated_by_user_id  uuid
);

-- Seed the singleton row with an empty override set (all defaults apply until
-- an admin tunes something in Settings → Coverage).
insert into paint_coverage_config (key, config)
values ('default', '{}'::jsonb)
on conflict (key) do nothing;
