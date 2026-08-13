-- 135 · project_id fills itself, in both directions
--
-- The backlog carried "delivery-row queries could filter by project_id now
-- that the column exists and is enforced" as hardening. Auditing it turned up
-- something worse than the item: **nothing writes project_id.**
--
-- Migration 131 added the column to eight tables, back-filled it once when a
-- project was created, and enforced that it can't DISAGREE with
-- opportunity_id. But no insert path sets it. So every invoice, change order,
-- AIA application, submittal, work order, close-out package, purchase and job
-- created AFTER its project already existed lands with project_id NULL.
--
-- Which means the hardening item, done as written, would have been a live bug:
-- switching reads from opportunity_id to project_id would have silently
-- dropped most rows on every job. The column looked enforced and was actually
-- half-empty — the same shape as an index everyone assumes is being maintained.
--
-- 131's trigger already fills opportunity_id FROM project_id when the row
-- arrives with only the project. This adds the mirror: fill project_id from
-- opportunity_id when the row arrives with only the opportunity. Doing it in
-- the trigger rather than at eight call sites is the point — a ninth caller
-- written next month cannot forget.
--
-- Still permissive where it should be: a pre-sale row whose deal has no
-- project yet, or a field-ops one-off with no opportunity at all, writes
-- exactly as before. The mirror only fires when a project genuinely exists.

CREATE OR REPLACE FUNCTION public.commercial_assert_project_matches_opp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  proj_opp UUID;
  opp_proj UUID;
BEGIN
  -- ── Mirror: row knows its opportunity but not its project ──
  -- The half that was missing. Without it project_id only ever got set by
  -- 131's one-time backfill, so it decayed from the first row created after.
  IF NEW.project_id IS NULL AND NEW.opportunity_id IS NOT NULL THEN
    SELECT id INTO opp_proj
      FROM public.commercial_projects
     WHERE opportunity_id = NEW.opportunity_id
       AND deleted_at IS NULL
     LIMIT 1;
    -- No project yet (a pre-sale row) is normal and stays NULL.
    IF opp_proj IS NOT NULL THEN
      NEW.project_id := opp_proj;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT opportunity_id INTO proj_opp
    FROM public.commercial_projects
   WHERE id = NEW.project_id;

  -- A project with no opportunity (direct T&M work) constrains nothing.
  IF proj_opp IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.opportunity_id IS NULL THEN
    NEW.opportunity_id := proj_opp;
    RETURN NEW;
  END IF;

  IF NEW.opportunity_id <> proj_opp THEN
    RAISE EXCEPTION
      'commercial: % row would point at opportunity % while its project % belongs to opportunity %',
      TG_TABLE_NAME, NEW.opportunity_id, NEW.project_id, proj_opp
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- 131 fired the trigger only on INSERT or on an UPDATE that touched one of the
-- two columns. The mirror needs plain INSERT too, which it already had — but
-- the UPDATE OF list is re-stated here so re-running 131 later cannot quietly
-- narrow it back.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'commercial_invoices',
    'commercial_change_orders',
    'commercial_aia_applications',
    'commercial_opp_submittals',
    'commercial_work_orders',
    'commercial_closeout_packages',
    'commercial_project_purchases',
    'commercial_jobs'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_project_match', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF project_id, opportunity_id ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.commercial_assert_project_matches_opp()',
      t || '_project_match', t
    );
  END LOOP;
END $$;

-- ── Repair the rows created since 131 ─────────────────────────────────────
-- Everything written between 131 and now carries a NULL project_id.
DO $$
DECLARE
  t TEXT;
  n BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'commercial_invoices',
    'commercial_change_orders',
    'commercial_aia_applications',
    'commercial_opp_submittals',
    'commercial_work_orders',
    'commercial_closeout_packages',
    'commercial_project_purchases',
    'commercial_jobs'
  ] LOOP
    EXECUTE format(
      'UPDATE public.%I r SET project_id = p.id '
      '  FROM public.commercial_projects p '
      ' WHERE p.opportunity_id = r.opportunity_id '
      '   AND p.deleted_at IS NULL '
      '   AND r.project_id IS NULL '
      '   AND r.opportunity_id IS NOT NULL', t
    );
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'backfilled % row(s) in %', n, t;
  END LOOP;
END $$;

-- ── Post-flight ───────────────────────────────────────────────────────────
-- Expect 0 for every table — a delivery row whose deal HAS a project should
-- now always carry it:
--
--   SELECT 'invoices' AS t, count(*) FROM commercial_invoices r
--     JOIN commercial_projects p ON p.opportunity_id = r.opportunity_id
--    WHERE r.project_id IS NULL AND p.deleted_at IS NULL
--   UNION ALL SELECT 'change_orders', count(*) FROM commercial_change_orders r
--     JOIN commercial_projects p ON p.opportunity_id = r.opportunity_id
--    WHERE r.project_id IS NULL AND p.deleted_at IS NULL
--   UNION ALL SELECT 'aia', count(*) FROM commercial_aia_applications r
--     JOIN commercial_projects p ON p.opportunity_id = r.opportunity_id
--    WHERE r.project_id IS NULL AND p.deleted_at IS NULL;
--
-- And nothing should ever disagree (expect 0):
--   SELECT count(*) FROM commercial_invoices r
--     JOIN commercial_projects p ON p.id = r.project_id
--    WHERE p.opportunity_id IS DISTINCT FROM r.opportunity_id;
