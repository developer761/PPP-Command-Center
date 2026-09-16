-- The Jobs report → the default folders, on a database that is already seeded.
--
-- 20260915190000 creates Manager / Finance / Field Users and fills them, but it
-- guards every folder with `continue when v_id is null` so a re-run never
-- touches one that already exists — deliberately, so Katie's edits survive. That
-- means adding 'jobs' to that file only helps a FRESH database; on the live one
-- the folders are already there and the new report would be invisible to
-- everyone who is not an admin.
--
-- So: file it, by folder id, and only where the folder still looks untouched on
-- this point (no row for 'jobs' yet). `on conflict do nothing` means running
-- this twice changes nothing, and an admin who later removes it from a folder
-- will not have it silently put back, because migrations run once.
--
--   Manager  — sees every report by definition.
--   Finance  — a job report IS the per-job money picture (billed, collected,
--              open balance, retainage, credits), which is the book Mary keeps.
--
-- Deliberately NOT Field Users. The report carries job margin, and who outside
-- management sees margin is a business decision for Alex and Katie, not a
-- default. An admin can add it in Settings → Report folders in two clicks.

insert into public.commercial_report_folder_items (folder_id, report_key, sort_order)
select f.id,
       'jobs',
       -- Just ahead of Job costs where it exists (the two belong together), else
       -- at the end of the folder.
       coalesce(
         (select min(i.sort_order) - 5
            from public.commercial_report_folder_items i
           where i.folder_id = f.id and i.report_key = 'job-costs'),
         (select coalesce(max(i.sort_order), 0) + 10
            from public.commercial_report_folder_items i
           where i.folder_id = f.id)
       )
  from public.commercial_report_folders f
 where f.id in (
         '6f1d3c2a-5b7e-4c1a-9d0e-000000000001'::uuid,  -- Manager
         '6f1d3c2a-5b7e-4c1a-9d0e-000000000002'::uuid   -- Finance
       )
   and f.deleted_at is null
on conflict (folder_id, report_key) do nothing;
