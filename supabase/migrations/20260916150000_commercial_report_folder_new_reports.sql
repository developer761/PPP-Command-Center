-- Put the new Tomco reports into the Manager folder.
--
-- The Manager folder is seeded with EVERY report (migration 20260915190000) and
-- a test holds it to that, so a new report has to be added to the seed for any
-- fresh environment. This adds the same rows to environments where that seed
-- has already run — otherwise Alex would not see a report that exists.
--
-- Idempotent: the table has UNIQUE (folder_id, report_key), so ON CONFLICT DO
-- NOTHING makes re-running it free. Adding the next Tomco report means adding
-- one line to the VALUES list in a new migration like this one.

insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
select f.id, v.report_key, v.sort_order
  from public.commercial_report_folders f
  cross join (values
    ('balance-owed', 200)
  ) as v(report_key, sort_order)
 where f.name = 'Manager'
on conflict (folder_id, report_key) do nothing;

-- Finance chases the money; Balance Owed is the report for it.
insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
select f.id, 'balance-owed', 200
  from public.commercial_report_folders f
 where f.name = 'Finance'
on conflict (folder_id, report_key) do nothing;

-- Proof: both folders must now list it.
select f.name, i.report_key
  from public.commercial_report_folder_items i
  join public.commercial_report_folders f on f.id = i.folder_id
 where i.report_key = 'balance-owed'
 order by f.name;
