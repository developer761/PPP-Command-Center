-- Migration 031: Phase 2 Batch 3 — Opportunity tasks + notes.
--
-- Two tables:
--   1. commercial_opportunity_tasks — to-dos with assignee + due_at +
--      completion tracking. Notification bell pings the assignee 24h
--      before due_at (cron, not yet wired in code — `notified_at`
--      column is reserved so the cron can dedupe re-fires).
--   2. commercial_opportunity_notes — free-form timeline entries with
--      edit/delete + soft-delete + author user.
--
-- Safe to re-run.

-- ============================================================
-- Tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS public.commercial_opportunity_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,

  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT,

  -- NULL = unassigned. Many tasks start unassigned and Alex routes them.
  assigned_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- DATE not TIMESTAMPTZ — time-of-day is irrelevant for due dates and
  -- DATE dodges midnight-TZ edge cases. May be in the past (historic /
  -- overdue task).
  due_at DATE,

  -- Completion tracking. Paired CHECK: both NULL (open) or both
  -- non-NULL (closed). UI uses completed_at IS NOT NULL as the gate.
  completed_at TIMESTAMPTZ,
  completed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CHECK (
    (completed_at IS NULL AND completed_by_user_id IS NULL)
    OR (completed_at IS NOT NULL AND completed_by_user_id IS NOT NULL)
  ),

  -- Notification dedup column. Set by the daily 24h-before-due cron
  -- after firing the bell, so a cron restart or partial run doesn't
  -- spam the assignee. NULL = not yet notified.
  notified_at TIMESTAMPTZ,

  -- Audit + soft delete (rare; created-by-mistake recovery).
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);

-- Per-opp open list, sorted by due_at ASC NULLS LAST (no due date = at
-- the bottom of the list). The index can't pre-sort due to NULLS LAST
-- semantics on partial indexes; we ORDER BY in the query instead.
CREATE INDEX IF NOT EXISTS commercial_opportunity_tasks_opp_active_idx
  ON public.commercial_opportunity_tasks (opportunity_id, due_at)
  WHERE deleted_at IS NULL AND completed_at IS NULL;

-- Notification cron path: "tasks due tomorrow that haven't been notified."
CREATE INDEX IF NOT EXISTS commercial_opportunity_tasks_due_idx
  ON public.commercial_opportunity_tasks (due_at)
  WHERE deleted_at IS NULL AND completed_at IS NULL AND notified_at IS NULL;

-- "My open tasks" surface (future).
CREATE INDEX IF NOT EXISTS commercial_opportunity_tasks_assigned_idx
  ON public.commercial_opportunity_tasks (assigned_user_id)
  WHERE deleted_at IS NULL AND completed_at IS NULL;

DROP TRIGGER IF EXISTS commercial_opportunity_tasks_set_updated_at
  ON public.commercial_opportunity_tasks;
CREATE TRIGGER commercial_opportunity_tasks_set_updated_at
  BEFORE UPDATE ON public.commercial_opportunity_tasks
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

-- ============================================================
-- Notes
-- ============================================================
CREATE TABLE IF NOT EXISTS public.commercial_opportunity_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,

  body TEXT NOT NULL CHECK (length(body) > 0),

  author_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Detail page reverse-chronological timeline.
CREATE INDEX IF NOT EXISTS commercial_opportunity_notes_opp_idx
  ON public.commercial_opportunity_notes (opportunity_id, created_at DESC)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS commercial_opportunity_notes_set_updated_at
  ON public.commercial_opportunity_notes;
CREATE TRIGGER commercial_opportunity_notes_set_updated_at
  BEFORE UPDATE ON public.commercial_opportunity_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();
