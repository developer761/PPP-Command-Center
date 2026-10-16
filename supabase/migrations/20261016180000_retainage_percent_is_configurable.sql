-- ============================================================================
-- A company-wide default retainage percentage.
-- ============================================================================
--
-- Karan, 2026-10-16: "make sure there's an easy way for us to change from 5 to
-- 10 percent."
--
-- Retainage is a contract term: the GC withholds a percentage — usually 5 or
-- 10 — of what it has been billed, and releases it when its own project closes
-- out and it has been paid in full. Which percentage applies is the GC's call,
-- so it varies by job.
--
-- It was a hardcoded 5 in lib/commercial/aia/constants.ts, reachable only by a
-- code change and a deploy, and every new certificate fell back to it whenever
-- the form came in blank. On a 10% job that is a trap with no feedback: miss
-- it once and the certificate under-withholds by half, the G702 goes to the GC
-- wrong, and line 5 disagrees with every earlier certificate on the same job.
--
-- Two changes close that, and this migration is the SECOND of them:
--
--   1. (code, no migration needed) a new certificate inherits the rate from
--      the job's own previous certificate, skipping releases — which run at 0,
--      and inheriting that zero would stop withholding altogether from the
--      first release onward. So the rate is typed once per job.
--
--   2. (here) a company-wide default for the FIRST certificate on a job,
--      editable at Settings → Operating Company.
--
-- Nullable rather than `default 5`: null means "nobody has chosen", and the
-- code then falls through to DEFAULT_RETAINAGE_PCT. A column defaulted to 5
-- would be indistinguishable from someone deliberately choosing 5, so Settings
-- could never show the difference between configured and unset.
--
-- The app tolerates this migration being un-applied. `getDefaultRetainagePct`
-- is a SEPARATE query from the main settings read for exactly that reason: an
-- unknown column makes PostgREST return an error with null data, and folding
-- it into the singleton select would have made every generated document
-- quietly fall back to the hardcoded company address and signer instead.

alter table public.commercial_operating_company
  add column if not exists default_retainage_pct smallint;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.commercial_operating_company'::regclass
       and conname  = 'commercial_operating_company_default_retainage_pct_range'
  ) then
    alter table public.commercial_operating_company
      add constraint commercial_operating_company_default_retainage_pct_range
      check (default_retainage_pct is null
             or (default_retainage_pct >= 0 and default_retainage_pct <= 100));
  end if;
end $$;

comment on column public.commercial_operating_company.default_retainage_pct is
  'Default retainage % for the FIRST AIA application on a job. Null = unset, '
  'so the code falls back to DEFAULT_RETAINAGE_PCT (5). Later applications '
  'inherit the rate from the job''s own previous certificate instead, so this '
  'is only ever the starting point. Releases always run at 0.';
