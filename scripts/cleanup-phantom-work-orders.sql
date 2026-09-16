-- Remove the empty draft work orders the Jobs page minted by itself.
--
-- WHAT HAPPENED (2026-09-16, during the Tomco migration):
-- `/commercial/field-ops/jobs` calls `ensureWorkOrdersForConnectedJobs()` on
-- every load. That looks for jobs which have an opportunity but no
-- `work_order_id` and creates a work order for each. The importer wrote 92 Field
-- Ops jobs without filling in `work_order_id`, so the first person to open that
-- page minted a second, empty, DRAFT work order on 46 Tomco deals — visible on
-- each deal's Work Orders tab, next to the real one.
--
-- The importer now sets `work_order_id` on every job it creates, so no more can
-- appear. This clears the ones already made.
--
-- SAFE BY CONSTRUCTION — a row must satisfy ALL of:
--   · not in commercial_import_map  → not one of the 92 we imported
--   · status = 'draft' and sent_at IS NULL → never went to a crew
--   · no scope lines, no area label → nothing was ever put on it
--   · nothing in commercial_jobs points at it
-- Anything a person has touched fails one of those and is left alone.
--
-- Paste into the Supabase SQL editor. The SELECT before and after is the proof.

BEGIN;

-- Before: how many are about to go, and what they are attached to.
SELECT count(*) AS phantom_work_orders
  FROM public.commercial_work_orders w
 WHERE w.status = 'draft'
   AND w.sent_at IS NULL
   AND w.area_label IS NULL
   AND coalesce(array_length(w.scope_line_item_ids, 1), 0) = 0
   AND NOT EXISTS (SELECT 1 FROM public.commercial_import_map m
                    WHERE m.entity = 'work_order' AND m.row_id = w.id)
   AND NOT EXISTS (SELECT 1 FROM public.commercial_jobs j WHERE j.work_order_id = w.id);

DELETE FROM public.commercial_work_orders w
 WHERE w.status = 'draft'
   AND w.sent_at IS NULL
   AND w.area_label IS NULL
   AND coalesce(array_length(w.scope_line_item_ids, 1), 0) = 0
   AND NOT EXISTS (SELECT 1 FROM public.commercial_import_map m
                    WHERE m.entity = 'work_order' AND m.row_id = w.id)
   AND NOT EXISTS (SELECT 1 FROM public.commercial_jobs j WHERE j.work_order_id = w.id);

COMMIT;

-- After: must read 92 — one work order per Tomco job, none spare.
SELECT count(*) AS work_orders_remaining FROM public.commercial_work_orders;
SELECT count(*) AS still_missing_sent_at FROM public.commercial_work_orders WHERE sent_at IS NULL;
