-- A deleted work order gives its job code back.
--
-- The same defect Stephanie reported on AIA applications this morning, sitting
-- on the Field Ops screen Mary uses:
--
--   commercial_jobs.job_code text not null unique   (migration 112, line 85)
--
-- The table soft-deletes (`deleted_at`, same migration), but the constraint is
-- not partial, so a deleted work order keeps its code for ever. The friendly
-- pre-check in lib/commercial/field-ops/jobs.ts filters `deleted_at is null`,
-- finds nothing, and the insert then dies on the real constraint — or, worse,
-- the pre-check DOES match nothing and the user is told:
--
--   Job code "TOMCO-PH1" is already in use.
--
-- pointing at a work order that is nowhere on screen. Create TOMCO-PH1, delete
-- it, create it again — which is exactly how you fix a typo in a code — and
-- the platform refuses on behalf of a row you cannot see.
--
-- `ensureJobForWorkOrder` was already patched for this once (it revives the
-- deleted twin rather than colliding). The MANUAL create and rename paths were
-- not, and those are the ones a person uses.
--
-- Partial index: two LIVE work orders still cannot share a code — the rule
-- that matters, because the code is what payroll and the calendar group by —
-- and a deleted one reserves nothing.
--
-- NAMED EXPLICITLY, NOT GUESSED. `drop constraint if exists <name>` on a name
-- I worked out from the convention silently did nothing earlier today: the
-- generated name was 65 characters and Postgres truncates at 63, so the real
-- constraint went on enforcing while the migration reported success. This
-- finds the constraint by its COLUMNS instead, whatever it ended up called.

do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'commercial_jobs'
       and con.contype = 'u'
       and (
         select array_agg(att.attname::text order by att.attname)
           from unnest(con.conkey) as k(attnum)
           join pg_attribute att
             on att.attrelid = con.conrelid and att.attnum = k.attnum
       ) = array['job_code']
  loop
    execute format('alter table public.commercial_jobs drop constraint %I', c.conname);
    raise notice 'dropped unique constraint %', c.conname;
  end loop;
end $$;

create unique index if not exists commercial_jobs_live_job_code_uidx
  on public.commercial_jobs (job_code)
  where deleted_at is null;

comment on index public.commercial_jobs_live_job_code_uidx is
  'Two LIVE work orders cannot share a job code. A deleted one releases its code so it can be created again. 2026-09-24.';
