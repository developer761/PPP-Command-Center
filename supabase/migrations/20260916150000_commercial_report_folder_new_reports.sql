-- The reports that stayed in Reports, into the folders that should see them.
--
-- Karan 2026-09-16: "all of Mary's stuff should be in accounting." So Balance
-- Owed, Purchases, Labor payments, Reimbursements, Deposits and Sales tax are
-- TABS on /commercial/accounting, not entries here — her work is in one place.
-- What is left is the sales and field side.
--
-- Idempotent: UNIQUE (folder_id, report_key) plus ON CONFLICT DO NOTHING.

insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
select f.id, v.report_key, v.sort_order
  from public.commercial_report_folders f
  cross join (values
    ('scheduling',  220),
    ('open-sales',  230),
    ('attendance',  280)
  ) as v(report_key, sort_order)
 where f.name in ('Manager', 'Field Users')
on conflict (folder_id, report_key) do nothing;

-- Finance wants what is in flight; the rest of her reporting is in Accounting.
insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
select f.id, 'open-sales', 230
  from public.commercial_report_folders f
 where f.name = 'Finance'
on conflict (folder_id, report_key) do nothing;

-- Clear out the report keys that briefly existed as their own pages. A folder
-- row pointing at a report the registry no longer has is dead weight.
delete from public.commercial_report_folder_items
 where report_key in (
   'pipeline-manager', 'balance-owed', 'purchases-by-vendor',
   'labor-payments', 'reimbursements-out', 'deposit-history', 'sales-tax'
 );

-- Proof: what each folder now holds.
select f.name, i.report_key, i.sort_order
  from public.commercial_report_folder_items i
  join public.commercial_report_folders f on f.id = i.folder_id
 where i.report_key in ('scheduling', 'open-sales', 'attendance')
 order by f.name, i.sort_order;
