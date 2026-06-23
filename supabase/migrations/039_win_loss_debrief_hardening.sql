-- Migration 039 — Hardening fixes for Win/Loss Debrief (post-audit batch)
--
-- Two additive changes, both paste-in-safe:
--
-- 1. UNIQUE(opportunity_id, status_log_id) on commercial_win_loss_debrief
--    Catches the "user double-tapped Save" race where two debrief rows
--    get inserted for the same closure event. Status_log_id is the FK
--    to commercial_opportunity_status_log — every status flip writes one
--    log row, so it's the natural per-closure key. NULL log_ids (orphans
--    from manual/script paths) bypass the unique check via a partial
--    index — they're rare and not worth blocking legitimate retries on.
--
-- 2. source_outcome TEXT on commercial_account_notes
--    Lets the two-stage debrief flow find the RIGHT placeholder when an
--    opp has been reopened-then-re-closed across multiple terminal states
--    (e.g. lost → reopened → won). Without this, findAutoDebriefNoteForOpp
--    falls back to the most recent placeholder by created_at, which can
--    enrich the wrong row with the wrong outcome data. Only set on
--    kind='auto_debrief' rows; user notes leave it NULL.

-- ============================================================
-- 1. UNIQUE on debrief per-closure
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS commercial_win_loss_debrief_opp_status_log_uniq
  ON public.commercial_win_loss_debrief (opportunity_id, status_log_id)
  WHERE status_log_id IS NOT NULL;

COMMENT ON INDEX public.commercial_win_loss_debrief_opp_status_log_uniq IS
  'Per-closure uniqueness — one debrief per status_log row. Lets the user re-debrief future closures (each gets a new status_log_id) without blocking, while preventing accidental double-submits on the same closure.';

-- ============================================================
-- 2. source_outcome on account_notes
-- ============================================================
ALTER TABLE public.commercial_account_notes
  ADD COLUMN IF NOT EXISTS source_outcome TEXT
  CHECK (source_outcome IS NULL OR source_outcome IN ('won', 'lost', 'no_bid'));

COMMENT ON COLUMN public.commercial_account_notes.source_outcome IS
  'For kind=auto_debrief rows: the opp outcome at the time the placeholder was written. Lets findAutoDebriefNoteForOpp filter to the correct placeholder when an opp has been reopened-then-re-closed across multiple outcomes.';

-- Replace the source-opp lookup index to also key on outcome (no-op for
-- the existing partial since outcome was NULL on the old rows; new rows
-- will populate it).
DROP INDEX IF EXISTS commercial_account_notes_source_opp_idx;
CREATE INDEX IF NOT EXISTS commercial_account_notes_source_opp_outcome_idx
  ON public.commercial_account_notes (source_opportunity_id, source_outcome, created_at DESC)
  WHERE kind = 'auto_debrief' AND deleted_at IS NULL;
