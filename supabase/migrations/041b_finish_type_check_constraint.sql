-- Phase 2.5 follow-up: CHECK constraint on commercial_opp_finishes.finish_type.
-- Migration 041 left finish_type as free-form TEXT; the other enums in that
-- migration (included_kinds, transmitted_as, response, status) all got CHECK
-- constraints. Audit recheck 2026-06-30 flagged the outlier — drift risk if
-- a future API caller bypasses the lib's FINISH_TYPES enum (paint, wood_stain,
-- primer, sealer, specialty).
--
-- Safe to re-run: drops + recreates the constraint idempotently.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'commercial_opp_finishes'
      AND constraint_name = 'commercial_opp_finishes_finish_type_check'
  ) THEN
    ALTER TABLE commercial_opp_finishes
      DROP CONSTRAINT commercial_opp_finishes_finish_type_check;
  END IF;

  ALTER TABLE commercial_opp_finishes
    ADD CONSTRAINT commercial_opp_finishes_finish_type_check
    CHECK (
      finish_type IS NULL
      OR finish_type IN ('paint', 'wood_stain', 'primer', 'sealer', 'specialty')
    );
END $$;
