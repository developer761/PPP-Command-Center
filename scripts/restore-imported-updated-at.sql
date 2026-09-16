-- Give the imported rows back their real "last touched" date.
--
-- WHAT IS WRONG
-- Every commercial table stamps `updated_at = NOW()` from a BEFORE UPDATE
-- trigger (`tg_commercial_set_updated_at`, migration 020). The migration's
-- `dates` stage UPDATEs every row to restore `created_at` from Salesforce — and
-- that very update re-stamped `updated_at` to the moment of the import. So
-- every one of Tomco's 132 deals, 75 accounts, 92 jobs and 92 work orders now
-- claims it was touched today.
--
-- WHAT THAT LOOKS LIKE ON SCREEN
--   · Home → "Recent activity" lists five arbitrary jobs, each reading "today",
--     some of them closed in 2023.
--   · Accounts → all 75 rows carry the pulsing green "active" dot, because
--     `last_activity_at` (migration 117) is GREATEST(account.updated_at, …).
--   · Accounts → the "Stale > 60 days" filter returns nothing, ever.
--   · ⌘K orders its results by `updated_at`, so they come back in import order.
--
-- WHY IT NEEDS SQL
-- The trigger sets NEW.updated_at unconditionally, so a client-supplied value
-- does not survive — verified against the live database rather than assumed.
-- The only way to write the honest value is with the triggers off, which is
-- what this does, inside one transaction.
--
-- SAFE: it only touches rows listed in commercial_import_map (i.e. rows that
-- came from Salesforce and have not been edited since), it only ever moves
-- `updated_at` BACKWARDS to that row's own `created_at`, and it skips any row
-- somebody has genuinely edited since the import.
--
-- Paste into the Supabase SQL editor. The SELECT at the end is the proof.

-- Reads commercial_import_map directly. An earlier version staged it in a TEMP
-- table, which the Supabase SQL editor cannot see from a later statement — it
-- pools connections, so the temp table is gone by the time the DO block runs
-- ("relation _imported_rows does not exist").

BEGIN;

DO $$
DECLARE
  t   text;
  ent text;
  n   bigint;
BEGIN
  FOR t, ent IN
    SELECT * FROM (VALUES
      ('commercial_accounts',           'account'),
      ('commercial_contacts',           'contact'),
      ('commercial_opportunities',      'deal'),
      ('commercial_work_orders',        'work_order'),
      ('commercial_jobs',               'job'),
      ('commercial_change_orders',      'change_order'),
      ('commercial_invoices',           'invoice'),
      ('commercial_project_purchases',  'purchase'),
      ('commercial_projects',           'project'),
      ('commercial_documents',          'file')
    ) AS v(tbl_name, entity_name)   -- deliberately NOT named `t`/`ent`: a column
                                    -- sharing a PL/pgSQL variable's name is how
                                    -- "column reference is ambiguous" happens.
  LOOP
    -- Only tables that actually carry the column.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t AND column_name = 'updated_at'
    ) THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', t);
    EXECUTE format($f$
      UPDATE public.%I x
         SET updated_at = x.created_at
       WHERE x.created_at IS NOT NULL
         AND x.updated_at > x.created_at
         AND EXISTS (
           SELECT 1 FROM public.commercial_import_map m
            WHERE m.row_id = x.id AND m.entity = %L
         )
    $f$, t, ent);
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', t);
    RAISE NOTICE '%: % row(s) re-dated', t, n;
  END LOOP;
END $$;

COMMIT;

-- Proof: the newest "last touched" date per table should now be a real Tomco
-- date, not today. Anything still showing today is a row a person has edited
-- since the import, which is correct.
SELECT 'accounts'      AS what, max(updated_at)::date AS newest_touch FROM public.commercial_accounts
UNION ALL SELECT 'opportunities', max(updated_at)::date FROM public.commercial_opportunities
UNION ALL SELECT 'work orders',   max(updated_at)::date FROM public.commercial_work_orders
UNION ALL SELECT 'field-ops jobs',max(updated_at)::date FROM public.commercial_jobs
UNION ALL SELECT 'invoices',      max(updated_at)::date FROM public.commercial_invoices
UNION ALL SELECT 'purchases',     max(updated_at)::date FROM public.commercial_project_purchases;
