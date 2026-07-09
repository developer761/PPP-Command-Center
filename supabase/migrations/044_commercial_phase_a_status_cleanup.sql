-- Migration 044: Phase A — remove site_visit statuses, cleanup
--
-- Karan 2026-07-09: post-meeting rewrite. The Opportunity status enum drops
-- `site_visit_scheduled` and `site_visit_done` — those were pre-sale steps
-- that never got real usage. Any historic rows on those statuses migrate
-- to `estimating` (the natural next phase).
--
-- Also stages structural fields for Phase B without adding them yet — we
-- want Phase A to ship independently and Phase B to layer without any
-- coupling. Phase B will run migration 045 to add the new columns.
--
-- Safe to re-run: uses IF EXISTS-safe UPDATE + no destructive DDL.

BEGIN;

-- Reassign historic rows off the retired statuses.
UPDATE public.commercial_opportunities
SET status = 'estimating', updated_at = now()
WHERE status IN ('site_visit_scheduled', 'site_visit_done');

-- Status log entries pointing at the retired statuses are preserved for
-- audit trail — we do NOT rewrite history. New reads will see the label
-- fallback ("(retired status)") when the enum client-side no longer
-- recognizes them. Bell notifications for those events stay valid.

COMMIT;
