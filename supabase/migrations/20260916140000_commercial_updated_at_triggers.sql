-- Make `updated_at` mean something on the tables Tomco is about to work in.
--
-- WHY NOW
-- From go-live Tomco runs BOTH systems for about two weeks: new work goes into
-- the platform while Salesforce is still being wound down. The importer keeps
-- pulling Salesforce across during that window, and it must never undo what
-- somebody typed here — Brendan moves a job to Scheduled, and a sync that
-- blindly re-applies Salesforce moves it straight back to Work In Progress.
--
-- The importer's guard asks one question of every row before overwriting it:
-- "has a person changed this since I last wrote it?" The only answer available
-- is `updated_at` versus the moment recorded in commercial_import_map.
--
-- THE PROBLEM THIS FIXES
-- Eleven commercial tables carry an `updated_at` column and only five ever
-- stamp it. On the other six the column has been decorative since it was
-- created: it holds the row's creation time forever, however many times the row
-- is edited. I found this by making the edit and watching the guard not fire —
-- the timestamp had not moved.
--
-- So the guard could not have worked, and separately, any screen ordering by
-- "recently updated" has been ordering by creation date on these tables.
--
-- `tg_commercial_set_updated_at` already exists (migration 020); this only
-- attaches it where it was missed. Idempotent: DROP then CREATE.

-- The crew's work orders and jobs — the two Brendan edits most.
DROP TRIGGER IF EXISTS commercial_work_orders_set_updated_at ON public.commercial_work_orders;
CREATE TRIGGER commercial_work_orders_set_updated_at
  BEFORE UPDATE ON public.commercial_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

DROP TRIGGER IF EXISTS commercial_jobs_set_updated_at ON public.commercial_jobs;
CREATE TRIGGER commercial_jobs_set_updated_at
  BEFORE UPDATE ON public.commercial_jobs
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

-- The money. `commercial_invoices.updated_at` was only ever moved by the
-- payment-recompute trigger (migration 042), so editing an invoice directly
-- left it untouched.
DROP TRIGGER IF EXISTS commercial_invoices_set_updated_at ON public.commercial_invoices;
CREATE TRIGGER commercial_invoices_set_updated_at
  BEFORE UPDATE ON public.commercial_invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

DROP TRIGGER IF EXISTS commercial_change_orders_set_updated_at ON public.commercial_change_orders;
CREATE TRIGGER commercial_change_orders_set_updated_at
  BEFORE UPDATE ON public.commercial_change_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

DROP TRIGGER IF EXISTS commercial_project_purchases_set_updated_at ON public.commercial_project_purchases;
CREATE TRIGGER commercial_project_purchases_set_updated_at
  BEFORE UPDATE ON public.commercial_project_purchases
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

-- The crew and their hours.
DROP TRIGGER IF EXISTS commercial_employees_set_updated_at ON public.commercial_employees;
CREATE TRIGGER commercial_employees_set_updated_at
  BEFORE UPDATE ON public.commercial_employees
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

DROP TRIGGER IF EXISTS commercial_time_entries_set_updated_at ON public.commercial_time_entries;
CREATE TRIGGER commercial_time_entries_set_updated_at
  BEFORE UPDATE ON public.commercial_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

-- NOT COVERED, on purpose: commercial_invoice_payments, commercial_crews and
-- commercial_crew_members have no `updated_at` column at all. A payment is
-- recorded rather than edited, and the crews came from Salesforce; the importer
-- treats a row it cannot date as untouched, which is the safe reading for these
-- three. If Tomco starts editing crews by hand during the dual-run, add the
-- column and the trigger before trusting the guard there.

-- Proof: every table below must now report a trigger.
SELECT c.relname AS table_name, t.tgname AS trigger_name
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal
   AND t.tgname LIKE '%set_updated_at'
   AND c.relname IN (
     'commercial_work_orders','commercial_jobs','commercial_invoices',
     'commercial_change_orders','commercial_project_purchases',
     'commercial_employees','commercial_time_entries'
   )
 ORDER BY c.relname;
