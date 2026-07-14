-- Migration 054: Exclusions Library (Phase F.0 pre-req for Proposal Builder).
--
-- Katie's 2026-07-13 spec + 5 real Tomco proposals (May-June 2026) surfaced
-- 8 recurring exclusions the estimator picks from repeatedly. Rather than
-- retyping the same 8 phrases into every proposal, store them once + let
-- ExclusionPicker multi-select from the library.
--
-- Two categories:
--   * standard — auto-added to every new proposal (2 canonical Tomco bullets)
--   * optional — hand-picked per proposal from the searchable library
--
-- Idempotent (IF NOT EXISTS everywhere). Seeds are conditional so a rerun
-- doesn't double-insert.

CREATE TABLE IF NOT EXISTS public.commercial_exclusions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'optional'
    CHECK (category IN ('standard', 'optional')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS commercial_exclusions_active_idx
  ON public.commercial_exclusions (is_active, category)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS commercial_exclusions_use_count_idx
  ON public.commercial_exclusions (use_count DESC)
  WHERE deleted_at IS NULL AND is_active = true;

-- Reuse the updated_at trigger convention from Phase D.
CREATE OR REPLACE FUNCTION public.set_updated_at_commercial_exclusions()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_commercial_exclusions_updated_at ON public.commercial_exclusions;
CREATE TRIGGER trg_commercial_exclusions_updated_at
  BEFORE UPDATE ON public.commercial_exclusions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_commercial_exclusions();

-- ═══════════════════════════════════════════════════════════════════
-- Seed the 8 canonical Tomco exclusions.
-- Observed across ALL 5 real 2026 proposals (Rodeo / Prime Place /
-- Water Lilies / Microchip / Brinkmann's).
-- Conditional inserts so a rerun doesn't duplicate.
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO public.commercial_exclusions (text, category)
SELECT 'Work to be completed during normal business hours.', 'standard'
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_exclusions
  WHERE text = 'Work to be completed during normal business hours.'
);

INSERT INTO public.commercial_exclusions (text, category)
SELECT 'Sales Tax, unless applicable.', 'standard'
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_exclusions
  WHERE text = 'Sales Tax, unless applicable.'
);

INSERT INTO public.commercial_exclusions (text, category)
SELECT 'Materials', 'optional'
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_exclusions WHERE text = 'Materials'
);

INSERT INTO public.commercial_exclusions (text, category)
SELECT 'Wallcovering & Areas Not in Contract (NIC)', 'optional'
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_exclusions
  WHERE text = 'Wallcovering & Areas Not in Contract (NIC)'
);

INSERT INTO public.commercial_exclusions (text, category)
SELECT 'Trim & Built-in Cabinetry', 'optional'
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_exclusions
  WHERE text = 'Trim & Built-in Cabinetry'
);

INSERT INTO public.commercial_exclusions (text, category)
SELECT 'Cement Floor and Cement Wall Paint', 'optional'
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_exclusions
  WHERE text = 'Cement Floor and Cement Wall Paint'
);

INSERT INTO public.commercial_exclusions (text, category)
SELECT 'Exterior Paint', 'optional'
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_exclusions WHERE text = 'Exterior Paint'
);

INSERT INTO public.commercial_exclusions (text, category)
SELECT 'Existing HM Doors', 'optional'
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_exclusions WHERE text = 'Existing HM Doors'
);

INSERT INTO public.commercial_exclusions (text, category)
SELECT 'Lift excluded, price will increase if needed', 'optional'
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_exclusions
  WHERE text = 'Lift excluded, price will increase if needed'
);

INSERT INTO public.commercial_exclusions (text, category)
SELECT 'Decorative Finish Wall & Ceiling', 'optional'
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_exclusions
  WHERE text = 'Decorative Finish Wall & Ceiling'
);

-- ═══════════════════════════════════════════════════════════════════
-- Atomic use_count increment RPC (F.0 post-audit fix).
-- lib/commercial/exclusions/db.ts bumpExclusionUseCount() calls this
-- so two proposals hitting the same exclusion at the same time can
-- never clobber each other's increment.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.bump_commercial_exclusion_use_count(p_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE public.commercial_exclusions
     SET use_count = use_count + 1
   WHERE id = p_id AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
