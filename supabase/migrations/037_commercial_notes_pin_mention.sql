-- Migration 037 — Stage 3 bonus-small batch: pinned notes + @mentions
--
-- Two additive columns on commercial_opportunity_notes:
--
--   1. pinned_at      — when the note was pinned (null = not pinned).
--      Sort key: pinned notes appear at the top of the per-opp list
--      ordered by pinned_at DESC (most-recently pinned wins the top).
--      Toggle = SET pinned_at = now() to pin / NULL to unpin.
--
--   2. mentioned_user_ids — array of profile.user_id strings whose
--      owners were @mentioned in the note body. Populated server-side
--      from a regex pass over the body that resolves @ tokens to
--      profiles. Used to drive a dedicated commercial_note_mention
--      bell+email instead of the generic team-fanout note_added one
--      for those specific recipients (so the alert has personal copy
--      and they don't get two emails for one note).
--
-- Paste-in safe: every ALTER uses IF NOT EXISTS.

ALTER TABLE public.commercial_opportunity_notes
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

ALTER TABLE public.commercial_opportunity_notes
  ADD COLUMN IF NOT EXISTS mentioned_user_ids TEXT[] NOT NULL DEFAULT '{}';

-- Index for the per-opp "show pinned first" sort. Partial so the index
-- only holds the (usually small) set of pinned notes — keeps it cheap
-- on a notes table that may grow large.
CREATE INDEX IF NOT EXISTS commercial_opportunity_notes_pinned_idx
  ON public.commercial_opportunity_notes (opportunity_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;

-- Optional support index for "find every note that mentioned user X"
-- (future Stage 4 dashboard widget). GIN on the TEXT[] column.
CREATE INDEX IF NOT EXISTS commercial_opportunity_notes_mentions_idx
  ON public.commercial_opportunity_notes USING GIN (mentioned_user_ids);

COMMENT ON COLUMN public.commercial_opportunity_notes.pinned_at IS
  'When the note was pinned. NULL = not pinned. Pinned notes sort to the top of the per-opp list, newest pin first.';
COMMENT ON COLUMN public.commercial_opportunity_notes.mentioned_user_ids IS
  '@mentioned profile.user_id values parsed from note body at insert time. Drives the commercial_note_mention bell+email kind.';
