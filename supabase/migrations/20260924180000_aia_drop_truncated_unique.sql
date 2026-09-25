-- The constraint the last migration failed to drop.
--
-- Stephanie, still blocked after 20260924160000 was applied:
--
--   duplicate key value violates unique constraint
--   "commercial_aia_applications_opportunity_id_application_numb_key"
--
-- Look at the name. It ends `application_numb_key`, not
-- `application_number_key`. Postgres truncates identifiers at 63 characters,
-- and the name it generated for that inline UNIQUE is 65:
--
--   commercial_aia_applications_opportunity_id_application_number_key  (65)
--   commercial_aia_applications_opportunity_id_application_numb_key    (63, actual)
--
-- The previous migration said `drop constraint if exists <the 65-char name>`.
-- No constraint had that name, `if exists` swallowed it, the migration
-- reported success, and the real constraint went on enforcing. The partial
-- index was created alongside it, so the table ended up with BOTH rules and
-- the stricter one still won.
--
-- `IF EXISTS` on a name you guessed is not a safe no-op — it is a silent one.
--
-- So this does not guess. It finds every UNIQUE constraint on
-- (opportunity_id, application_number) whatever it is called, and drops it.
-- The partial index from 20260924160000 stays and does the real work:
-- two LIVE applications cannot share a number, a deleted one reserves nothing.
--
-- (commercial_change_orders was fine — its generated name is 53 characters,
-- so that drop matched and worked.)

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
       and rel.relname = 'commercial_aia_applications'
       and con.contype = 'u'
       -- exactly the two columns, in either order
       and (
         select array_agg(att.attname::text order by att.attname)
           from unnest(con.conkey) as k(attnum)
           join pg_attribute att
             on att.attrelid = con.conrelid and att.attnum = k.attnum
       ) = array['application_number', 'opportunity_id']
  loop
    execute format(
      'alter table public.commercial_aia_applications drop constraint %I',
      c.conname
    );
    raise notice 'dropped unique constraint %', c.conname;
  end loop;
end $$;

-- Re-assert the partial index, in case it was never created.
create unique index if not exists commercial_aia_applications_live_number_uidx
  on public.commercial_aia_applications (opportunity_id, application_number)
  where deleted_at is null;
