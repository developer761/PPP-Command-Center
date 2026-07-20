-- ────────────────────────────────────────────────────────────────────
-- Migration 067 — Archive support on opportunities
-- ────────────────────────────────────────────────────────────────────
-- Karan 2026-07-20 (Phase G Q3): Katie's "archive feature" ask —
-- hide dead deals (Lost / No-bid / stale) from the active pipeline
-- without hard-deleting the audit trail. Dependents (proposals,
-- invoices, submittals) stay visible in their own list views; only
-- the parent opp disappears from the active-deal Kanban + list.
-- Reversible via unarchive button on the archived-only view.
--
-- Nullable columns — an opp with archived_at IS NULL is active.
-- Existing rows all default to NULL (unarchived), so no backfill.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Safe to re-run.

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by_user_id UUID;

-- Partial index: fast lookup of archived opps for the /archived view.
CREATE INDEX IF NOT EXISTS commercial_opportunities_archived_idx
  ON public.commercial_opportunities (archived_at)
  WHERE archived_at IS NOT NULL;

-- Partial index: fast "active" list queries (kanban, list, account tab)
-- — the dominant read path. Filters to non-archived + non-deleted only.
CREATE INDEX IF NOT EXISTS commercial_opportunities_active_idx
  ON public.commercial_opportunities (account_id, updated_at DESC)
  WHERE archived_at IS NULL AND deleted_at IS NULL;
