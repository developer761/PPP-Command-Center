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

-- Round two: the deal-shaped Tomco reports.
insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
select f.id, v.report_key, v.sort_order
  from public.commercial_report_folders f
  cross join (values
    ('scheduling',       220),
    ('open-sales',       230)
  ) as v(report_key, sort_order)
 where f.name in ('Manager', 'Field Users')
on conflict (folder_id, report_key) do nothing;

-- Finance wants what is owed and what is in flight, not the bid list.
insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
select f.id, 'open-sales', 230
  from public.commercial_report_folders f
 where f.name = 'Finance'
on conflict (folder_id, report_key) do nothing;

-- Round three: Mary's money-in and money-out reports.
insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
select f.id, v.report_key, v.sort_order
  from public.commercial_report_folders f
  cross join (values
    ('purchases-by-vendor', 240),
    ('labor-payments',      250),
    ('reimbursements-out',  260),
    ('deposit-history',     270)
  ) as v(report_key, sort_order)
 where f.name in ('Manager', 'Finance')
on conflict (folder_id, report_key) do nothing;

-- Round four: Attendance — the report that makes the crew hours visible.
insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
select f.id, 'attendance', 280
  from public.commercial_report_folders f
 where f.name in ('Manager', 'Field Users', 'Finance')
on conflict (folder_id, report_key) do nothing;

-- Round five: Sales Tax, which Mary files from.
insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
select f.id, 'sales-tax', 290
  from public.commercial_report_folders f
 where f.name in ('Manager', 'Finance')
on conflict (folder_id, report_key) do nothing;

-- Opportunity Pipeline Manager became the Pipeline report itself (the table now
-- sits above the funnel on /commercial/reports/pipeline), so the separate entry
-- is removed. Harmless if it was never inserted.
delete from public.commercial_report_folder_items where report_key = 'pipeline-manager';
