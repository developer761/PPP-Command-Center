-- 126: record WHO caused each status change — a person, or the system.
--
-- The auto-advance engine must not undo a human. The obvious test, "was the
-- last status_log row written by a user", does not work: every proposal
-- cascade (send, mark won, revision bump) runs inside a human's request and
-- passes that human's id, so `changed_by_user_id IS NOT NULL` is true for
-- automatic moves too. Only the reconciler passes NULL. Without a real signal
-- the guard would refuse to advance anything ever again after the first send.
--
-- `source` records the intent instead of inferring it from the actor:
--   user         — a person chose this status (drag, dropdown, debrief form)
--   auto_advance — an artifact implied it (proposal sent, closeout completed)
--   reconcile    — a drift-healing pass
--
-- Safe to re-run.

ALTER TABLE public.commercial_opportunity_status_log
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';

-- Existing rows: the reconciler is the one writer that left the actor NULL, so
-- that is the only group we can identify after the fact. Everything else stays
-- 'user' — the safe default, since a row wrongly labelled 'user' makes the
-- engine too cautious (skips an advance) rather than too eager (overwrites a
-- person's decision).
UPDATE public.commercial_opportunity_status_log
  SET source = 'reconcile'
  WHERE changed_by_user_id IS NULL AND source = 'user';

ALTER TABLE public.commercial_opportunity_status_log
  DROP CONSTRAINT IF EXISTS commercial_opportunity_status_log_source_check;

ALTER TABLE public.commercial_opportunity_status_log
  ADD CONSTRAINT commercial_opportunity_status_log_source_check
  CHECK (source IN ('user', 'auto_advance', 'reconcile'));

-- The guard's hot query: "most recent human move on this deal".
CREATE INDEX IF NOT EXISTS commercial_opportunity_status_log_user_moves_idx
  ON public.commercial_opportunity_status_log (opportunity_id, changed_at DESC)
  WHERE source = 'user';

-- When a PERSON last set this deal's status, sub-status included.
--
-- The status_log can't answer this on its own: it only gets a row when the
-- TOP-LEVEL status changes, so a person moving a card from the Proposal column
-- back to Estimating -- which changes only the sub-status -- leaves no trace
-- for the guard to find, and the next page load quietly snaps the card
-- forward again. One column on the deal captures every human decision,
-- whichever part of the status they changed.
ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS status_user_set_at TIMESTAMPTZ;

-- Backfill from the most recent human-looking log row, so existing deals get
-- the protection immediately rather than only after someone touches them.
UPDATE public.commercial_opportunities o
  SET status_user_set_at = l.changed_at
  FROM (
    SELECT DISTINCT ON (opportunity_id) opportunity_id, changed_at
      FROM public.commercial_opportunity_status_log
      WHERE changed_by_user_id IS NOT NULL
      ORDER BY opportunity_id, changed_at DESC
  ) l
  WHERE l.opportunity_id = o.id AND o.status_user_set_at IS NULL;
