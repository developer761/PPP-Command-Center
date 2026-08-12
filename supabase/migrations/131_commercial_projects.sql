-- 131: split the WORK from the SALE.
--
-- Karan 2026-08-12, from notes he and Katie wrote:
--
--   Opps         — Opp         | Name   | Owner | Amount | ID
--   Projects     — Project     | Name   | Owner | Amount | ID | Oppty ID
--   Transaction  — Transaction | Amount | Date  | ID     | Project ID
--
-- The two columns that earn the table are Owner and Amount. One person sells
-- the job and a different person runs it; the price bid is not the contract
-- delivered. Collapsing either pair into a single field on the opportunity is
-- what produced the signed-contract bug fixed earlier this month, so this
-- removes a class of problem rather than one instance of it.
--
-- The UI does NOT split. One page still shows the whole job and grows its
-- delivery half at the win; nobody navigates to a second record.
--
-- Safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commercial_projects (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- UNIQUE enforces 1:1 and is what makes creation idempotent under a status
  -- that bounces won → lost → won. NULLABLE so a T&M job that never had a bid
  -- can exist without inventing a fake opportunity.
  --
  -- ON DELETE RESTRICT: deleting an opportunity whose project holds invoices
  -- must fail loudly rather than cascade money into the void.
  opportunity_id        UUID UNIQUE REFERENCES public.commercial_opportunities(id) ON DELETE RESTRICT,

  -- Inherited from the opportunity, never re-issued. project_number is assigned
  -- at OPPORTUNITY insert (migration 046), so numbers are already printed on
  -- PDFs, emails and AIA cover sheets in the field — including on lost bids.
  -- Re-numbering here would break every one of them.
  project_number        TEXT,
  name                  TEXT NOT NULL,

  -- The PM. Defaults to the estimator who sold it and is changed afterwards;
  -- the whole point is that it can differ from the opportunity's owner.
  owner_user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- The agreed figure at award. Set once, never recomputed.
  -- NULL means "not set" and must render as such — never as $0.00, which reads
  -- as a real number and poisons every rollup above it.
  contract_base_cents   BIGINT,
  contract_source       TEXT,

  status                TEXT NOT NULL DEFAULT 'awarded',

  started_at                DATE,
  substantially_complete_at DATE,
  closed_out_at             DATE,

  -- Mirrored from the opportunity at creation so a soft-deleted or archived
  -- deal's project doesn't reappear in live lists.
  archived_at           TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.commercial_projects
  DROP CONSTRAINT IF EXISTS commercial_projects_status_check;
ALTER TABLE public.commercial_projects
  ADD CONSTRAINT commercial_projects_status_check
  CHECK (status IN ('awarded', 'pre_construction', 'in_progress', 'billing', 'closed_out'));

ALTER TABLE public.commercial_projects
  DROP CONSTRAINT IF EXISTS commercial_projects_contract_source_check;
ALTER TABLE public.commercial_projects
  ADD CONSTRAINT commercial_projects_contract_source_check
  CHECK (contract_source IS NULL OR contract_source IN
    ('accepted_snapshot', 'won_proposal', 'latest_proposal', 'manual'));

CREATE INDEX IF NOT EXISTS commercial_projects_opp_idx
  ON public.commercial_projects (opportunity_id);
CREATE INDEX IF NOT EXISTS commercial_projects_owner_idx
  ON public.commercial_projects (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commercial_projects_status_idx
  ON public.commercial_projects (status) WHERE deleted_at IS NULL;

COMMENT ON TABLE public.commercial_projects IS
  'The WORK half of a job. The opportunity is the sale. Created at the win; '
  'carries its own owner (the PM) and its own amount (the contract), which is '
  'the entire reason it is a separate table.';
COMMENT ON COLUMN public.commercial_projects.contract_base_cents IS
  'Agreed figure at award. Set once, never recomputed. Current contract value '
  '= this + approved change orders, computed at read time and never stored. '
  'NULL means not set and must render as "not set", never $0.00.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. project_id on the delivery tables
-- ─────────────────────────────────────────────────────────────────────────────
--
-- opportunity_id STAYS on all eight. It is referenced 872 times across 75
-- files and rewriting every call site in one commit is where this would go
-- wrong. Section 3 makes keeping both safe.

ALTER TABLE public.commercial_invoices           ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.commercial_projects(id) ON DELETE RESTRICT;
ALTER TABLE public.commercial_change_orders      ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.commercial_projects(id) ON DELETE RESTRICT;
ALTER TABLE public.commercial_aia_applications   ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.commercial_projects(id) ON DELETE RESTRICT;
ALTER TABLE public.commercial_opp_submittals     ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.commercial_projects(id) ON DELETE RESTRICT;
ALTER TABLE public.commercial_work_orders        ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.commercial_projects(id) ON DELETE RESTRICT;
ALTER TABLE public.commercial_closeout_packages  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.commercial_projects(id) ON DELETE RESTRICT;
ALTER TABLE public.commercial_project_purchases  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.commercial_projects(id) ON DELETE RESTRICT;
ALTER TABLE public.commercial_jobs               ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.commercial_projects(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS commercial_invoices_project_idx          ON public.commercial_invoices (project_id);
CREATE INDEX IF NOT EXISTS commercial_change_orders_project_idx     ON public.commercial_change_orders (project_id);
CREATE INDEX IF NOT EXISTS commercial_aia_applications_project_idx  ON public.commercial_aia_applications (project_id);
CREATE INDEX IF NOT EXISTS commercial_opp_submittals_project_idx    ON public.commercial_opp_submittals (project_id);
CREATE INDEX IF NOT EXISTS commercial_work_orders_project_idx       ON public.commercial_work_orders (project_id);
CREATE INDEX IF NOT EXISTS commercial_closeout_packages_project_idx ON public.commercial_closeout_packages (project_id);
CREATE INDEX IF NOT EXISTS commercial_project_purchases_project_idx ON public.commercial_project_purchases (project_id);
CREATE INDEX IF NOT EXISTS commercial_jobs_project_idx              ON public.commercial_jobs (project_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The drift guard — what makes keeping both columns safe
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Two columns pointing at the same job is exactly the shape that caused the
-- contract bug, so it is not left to convention. A project's opportunity_id
-- never changes after creation, which means the mirror CANNOT drift — provided
-- something enforces it. This is that something.
--
-- Deliberately permissive in two directions:
--   * project_id NULL — a pre-sale row, or a field-ops one-off. Fine.
--   * opportunity_id NULL on the row while the project has one — the row is
--     being migrated forward. Fill it in, don't reject the write.
-- It fires only when both are present and they genuinely disagree.

CREATE OR REPLACE FUNCTION public.commercial_assert_project_matches_opp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  proj_opp UUID;
BEGIN
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Backfill
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHO GETS A PROJECT: a deal that was WON, **or** one already carrying delivery
-- artifacts.
--
-- The second half is not belt-and-braces. Pre-flight against live data found
-- only ONE deal in a delivery status while SEVEN sit in pre_sale_closed/won
-- already carrying invoices, AIA applications, work orders, submittals and
-- closeout packages. A ladder-position rule would have created 1 project
-- instead of 9 and left seven won jobs' money attached to nothing.
--
-- Soft-deleted and archived deals are included, inheriting their flags, so no
-- money row is ever left dangling.

INSERT INTO public.commercial_projects (
  opportunity_id, project_number, name, owner_user_id,
  contract_base_cents, contract_source, status,
  closed_out_at, archived_at, deleted_at, created_by_user_id
)
SELECT
  o.id,
  o.project_number,
  COALESCE(NULLIF(TRIM(o.title_override), ''), NULLIF(TRIM(o.title), ''), 'Untitled project'),
  COALESCE(o.estimator_user_id, o.created_by_user_id),

  -- The ladder, at award. The remembered snapshot first (migration 127, written
  -- by snapshotAcceptedContract at the moment of the win), then a live winning
  -- proposal, then the latest one the customer has actually seen. Anything
  -- below that is a guess and NULL is the honest answer.
  COALESCE(
    NULLIF(o.accepted_contract_cents, 0),
    (SELECT NULLIF(MAX(p.total_cents), 0) FROM public.commercial_proposals p
      WHERE p.opportunity_id = o.id AND p.status = 'won' AND p.deleted_at IS NULL),
    (SELECT NULLIF(MAX(p.total_cents), 0) FROM public.commercial_proposals p
      WHERE p.opportunity_id = o.id AND p.deleted_at IS NULL
        AND p.status IN ('sent', 'won', 'lost', 'expired', 'superseded'))
  ),
  CASE
    WHEN NULLIF(o.accepted_contract_cents, 0) IS NOT NULL THEN 'accepted_snapshot'
    WHEN EXISTS (SELECT 1 FROM public.commercial_proposals p
                  WHERE p.opportunity_id = o.id AND p.status = 'won'
                    AND p.deleted_at IS NULL AND p.total_cents > 0) THEN 'won_proposal'
    WHEN EXISTS (SELECT 1 FROM public.commercial_proposals p
                  WHERE p.opportunity_id = o.id AND p.deleted_at IS NULL
                    AND p.status IN ('sent','won','lost','expired','superseded')
                    AND p.total_cents > 0) THEN 'latest_proposal'
    ELSE NULL
  END,
  CASE o.status
    WHEN 'pre_construction'  THEN 'pre_construction'
    WHEN 'in_progress'       THEN 'in_progress'
    WHEN 'billing'           THEN 'billing'
    WHEN 'post_sale_closed'  THEN 'closed_out'
    ELSE 'awarded'
  END,
  o.closed_out_at,
  o.archived_at,
  o.deleted_at,
  o.created_by_user_id
FROM public.commercial_opportunities o
WHERE
  (
    (o.status = 'pre_sale_closed' AND o.sub_status = 'won')
    OR o.status IN ('pre_construction', 'in_progress', 'billing', 'post_sale_closed')
    OR EXISTS (SELECT 1 FROM public.commercial_invoices           x WHERE x.opportunity_id = o.id)
    OR EXISTS (SELECT 1 FROM public.commercial_change_orders      x WHERE x.opportunity_id = o.id)
    OR EXISTS (SELECT 1 FROM public.commercial_aia_applications   x WHERE x.opportunity_id = o.id)
    OR EXISTS (SELECT 1 FROM public.commercial_opp_submittals     x WHERE x.opportunity_id = o.id)
    OR EXISTS (SELECT 1 FROM public.commercial_work_orders        x WHERE x.opportunity_id = o.id)
    OR EXISTS (SELECT 1 FROM public.commercial_closeout_packages  x WHERE x.opportunity_id = o.id)
    OR EXISTS (SELECT 1 FROM public.commercial_project_purchases  x WHERE x.opportunity_id = o.id)
    OR EXISTS (SELECT 1 FROM public.commercial_jobs               x WHERE x.opportunity_id = o.id)
  )
ON CONFLICT (opportunity_id) DO NOTHING;

-- Link the delivery rows. Guarded by `project_id IS NULL` so a re-run never
-- moves a row that has since been re-pointed by hand.
UPDATE public.commercial_invoices          r SET project_id = p.id FROM public.commercial_projects p WHERE p.opportunity_id = r.opportunity_id AND r.project_id IS NULL;
UPDATE public.commercial_change_orders     r SET project_id = p.id FROM public.commercial_projects p WHERE p.opportunity_id = r.opportunity_id AND r.project_id IS NULL;
UPDATE public.commercial_aia_applications  r SET project_id = p.id FROM public.commercial_projects p WHERE p.opportunity_id = r.opportunity_id AND r.project_id IS NULL;
UPDATE public.commercial_opp_submittals    r SET project_id = p.id FROM public.commercial_projects p WHERE p.opportunity_id = r.opportunity_id AND r.project_id IS NULL;
UPDATE public.commercial_work_orders       r SET project_id = p.id FROM public.commercial_projects p WHERE p.opportunity_id = r.opportunity_id AND r.project_id IS NULL;
UPDATE public.commercial_closeout_packages r SET project_id = p.id FROM public.commercial_projects p WHERE p.opportunity_id = r.opportunity_id AND r.project_id IS NULL;
UPDATE public.commercial_project_purchases r SET project_id = p.id FROM public.commercial_projects p WHERE p.opportunity_id = r.opportunity_id AND r.project_id IS NULL;
UPDATE public.commercial_jobs              r SET project_id = p.id FROM public.commercial_projects p WHERE p.opportunity_id = r.opportunity_id AND r.project_id IS NULL;

-- updated_at maintenance, matching the pattern used elsewhere in this schema.
CREATE OR REPLACE FUNCTION public.commercial_projects_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commercial_projects_touch ON public.commercial_projects;
CREATE TRIGGER commercial_projects_touch
  BEFORE UPDATE ON public.commercial_projects
  FOR EACH ROW EXECUTE FUNCTION public.commercial_projects_touch_updated_at();
