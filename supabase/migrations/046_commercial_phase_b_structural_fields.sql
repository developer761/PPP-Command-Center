-- 046_commercial_phase_b_structural_fields.sql
--
-- Phase B (Plan v1.1) — Opportunity structural fields + Project Number.
-- Per Alex's email: Opportunities/Projects need unique identifiers
-- (Project Numbers). Standardized display name derived at read time:
--   {account.company_name} - {client_name} - {location_short}
-- Estimator required at estimating+ (server-side validated in the lib).
--
-- Adds 4 columns to commercial_opportunities:
--   - client_name TEXT              (Alex's customer — the end client)
--   - location_short TEXT           (short site label)
--   - estimator_user_id UUID        (FK auth.users, SET NULL on user delete)
--   - project_number TEXT UNIQUE    (YYYY-NNNN, auto-assigned on insert)
--
-- Adds a per-year counter table so numbers reset each Jan 1 without a
-- cron. Sequence-per-year via UPSERT keeps the assign function
-- concurrency-safe (Postgres serializes ON CONFLICT DO UPDATE per key).
--
-- Idempotent throughout. Rerun-safe.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════
-- 1. Add the four columns. All nullable at row level — the lib
--    (changeOpportunityStatus) enforces required-at-estimating for
--    client_name / location_short / estimator_user_id. project_number
--    is populated by the trigger on step 4.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS client_name TEXT;

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS location_short TEXT;

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS estimator_user_id UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS project_number TEXT;

COMMENT ON COLUMN public.commercial_opportunities.client_name IS
  'The end client (the customer of Alex''s GC account). Nullable at
   solicitation; required at estimating+ per Plan v1.1 Phase B.';

COMMENT ON COLUMN public.commercial_opportunities.location_short IS
  'Short site-address label used in the standardized display name.
   Nullable at solicitation; required at estimating+.';

COMMENT ON COLUMN public.commercial_opportunities.estimator_user_id IS
  'Assigned estimator. Required at estimating+ per Plan v1.1 Phase B.
   SET NULL on user delete — an amber "needs re-assignment" banner
   renders on the opp detail page (Phase B UI).';

COMMENT ON COLUMN public.commercial_opportunities.project_number IS
  'Human-readable unique identifier, format YYYY-NNNN (e.g. 2026-0142).
   Assigned server-side by the BEFORE INSERT trigger. Carries through
   to commercial_projects on Won conversion (Phase H).';

-- ═══════════════════════════════════════════════════════════════════
-- 2. Per-year counter table backing the project_number assignment.
--    One row per year; UPSERT on INSERT is atomic + concurrent-safe.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.commercial_project_number_counters (
  year INT PRIMARY KEY,
  last_number INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.commercial_project_number_counters IS
  'Per-year sequence counter for opportunity project_number assignment.
   Auto-populated by assign_commercial_project_number(). One row per
   calendar year. Numbers reset each Jan 1 via new-year INSERT.';

-- ═══════════════════════════════════════════════════════════════════
-- 3. Assign function. Returns "YYYY-NNNN" where NNNN is zero-padded
--    to 4 digits (so sort-friendly for the first 9999 opps per year).
--    Uses ON CONFLICT DO UPDATE with RETURNING so a race between two
--    concurrent inserts serializes on the counter row's per-key lock.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.assign_commercial_project_number()
RETURNS TRIGGER AS $$
DECLARE
  current_year INT := EXTRACT(YEAR FROM COALESCE(NEW.created_at, NOW()))::INT;
  next_number INT;
BEGIN
  -- Respect explicit values (data import, restore, backfill).
  IF NEW.project_number IS NOT NULL AND NEW.project_number <> '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.commercial_project_number_counters AS c (year, last_number, updated_at)
  VALUES (current_year, 1, NOW())
  ON CONFLICT (year) DO UPDATE
    SET last_number = c.last_number + 1,
        updated_at = NOW()
  RETURNING last_number INTO next_number;

  NEW.project_number := current_year::TEXT || '-' || LPAD(next_number::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════
-- 4. Trigger. BEFORE INSERT so the assigned value hits the row before
--    any RLS / RETURNING gets the final row shape.
-- ═══════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS assign_project_number_trigger
  ON public.commercial_opportunities;

CREATE TRIGGER assign_project_number_trigger
BEFORE INSERT ON public.commercial_opportunities
FOR EACH ROW
EXECUTE FUNCTION public.assign_commercial_project_number();

-- ═══════════════════════════════════════════════════════════════════
-- 5. Backfill project_number on all existing rows.
--    Numbers are assigned by created_at within each year, so the
--    order matches the chronological ordering Alex would expect.
--    Skipped for rows that already have a value (idempotent rerun).
-- ═══════════════════════════════════════════════════════════════════

WITH numbered AS (
  SELECT
    id,
    EXTRACT(YEAR FROM created_at)::INT AS y,
    ROW_NUMBER() OVER (
      PARTITION BY EXTRACT(YEAR FROM created_at)::INT
      ORDER BY created_at, id
    ) AS n
  FROM public.commercial_opportunities
  WHERE project_number IS NULL
)
UPDATE public.commercial_opportunities o
   SET project_number = numbered.y::TEXT || '-' || LPAD(numbered.n::TEXT, 4, '0'),
       updated_at = NOW()
  FROM numbered
 WHERE o.id = numbered.id;

-- ═══════════════════════════════════════════════════════════════════
-- 6. Seed the per-year counter to match the highest backfilled number
--    so future inserts continue the sequence instead of colliding.
--    GREATEST() protects against a rerun that would otherwise reset
--    a live counter.
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO public.commercial_project_number_counters (year, last_number, updated_at)
SELECT
  EXTRACT(YEAR FROM created_at)::INT AS y,
  MAX(CAST(SPLIT_PART(project_number, '-', 2) AS INT)) AS max_n,
  NOW()
  FROM public.commercial_opportunities
 WHERE project_number IS NOT NULL
   AND project_number ~ '^[0-9]{4}-[0-9]+$'
 GROUP BY EXTRACT(YEAR FROM created_at)::INT
ON CONFLICT (year) DO UPDATE
  SET last_number = GREATEST(
        commercial_project_number_counters.last_number,
        EXCLUDED.last_number
      ),
      updated_at = NOW();

-- ═══════════════════════════════════════════════════════════════════
-- 7. Add the UNIQUE constraint on project_number. Safe now that every
--    row has a value AND the format is guaranteed distinct per year
--    (via the counter table) and per YYYY-NNNN prefix.
-- ═══════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'commercial_opportunities_project_number_key'
       AND conrelid = 'public.commercial_opportunities'::regclass
  ) THEN
    ALTER TABLE public.commercial_opportunities
      ADD CONSTRAINT commercial_opportunities_project_number_key
      UNIQUE (project_number);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- 8. Indexes for hot paths (search, filter, join).
-- ═══════════════════════════════════════════════════════════════════

-- project_number lookups: e.g. quicksearch, bell notification links,
-- print-header display. UNIQUE index above already covers exact match.

-- Estimator scoping: pipeline filter ?estimator=<user_id> + rep
-- profile "opportunities assigned to me" widget.
CREATE INDEX IF NOT EXISTS commercial_opportunities_estimator_idx
  ON public.commercial_opportunities (estimator_user_id)
  WHERE estimator_user_id IS NOT NULL AND deleted_at IS NULL;

-- Duplicate detection: (account_id, client_name, location_short)
-- lookup on the New Opportunity form.
CREATE INDEX IF NOT EXISTS commercial_opportunities_dup_detect_idx
  ON public.commercial_opportunities (account_id, LOWER(client_name), LOWER(location_short))
  WHERE deleted_at IS NULL AND client_name IS NOT NULL AND location_short IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 9. Diagnostic notice.
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  backfilled INT;
  counter_years INT;
BEGIN
  SELECT COUNT(*) INTO backfilled
    FROM public.commercial_opportunities
   WHERE project_number IS NOT NULL;
  SELECT COUNT(*) INTO counter_years
    FROM public.commercial_project_number_counters;
  RAISE NOTICE 'Migration 046: complete. % opportunity rows carry a project_number; % year(s) seeded in counter table.', backfilled, counter_years;
END $$;

COMMIT;
