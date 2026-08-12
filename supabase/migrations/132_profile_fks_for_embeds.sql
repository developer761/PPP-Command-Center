-- 132: let PostgREST see the link between a user_id column and `profiles`.
--
-- Found in a live production log (Karan 2026-08-12):
--
--   [commercial/opportunities/notes] list failed: Could not find a relationship
--   between 'commercial_opportunity_notes' and 'profiles' in the schema cache
--
-- Thirteen queries across ten files embed `profiles` off a user_id column,
-- naming a foreign key that points at `auth.users` — not at `profiles`. Every
-- one returns PGRST200, every one is wrapped in a guard that logs a warning and
-- returns an empty list, and the callers cannot tell "this failed" from "there
-- is nothing here". So:
--
--   * account + opportunity TEAM lists rendered empty
--   * the status-change notification fan-out found nobody to email
--   * four cron jobs (dunning, hot-deals-cooling, debrief-overdue, expiring
--     documents) found nobody to notify
--   * notes lost their author, and then the whole notes list
--
-- None of it surfaced, because a silent empty list looks exactly like a quiet
-- week.
--
-- The fix is a real constraint rather than thirteen rewrites. Verified against
-- live data before writing this: every referenced user_id already exists in
-- `profiles` (41 references, 0 orphans), so nothing is rejected.
--
-- NAMED to match the hint the code already passes. That matters twice over:
-- these columns keep their auth.users FK as well, so there are now TWO
-- relationships between each pair — exactly the ambiguity that took the
-- proposal page down this morning (migration 127). An unnamed embed would be
-- ambiguous; the code names its FK, so it resolves.
--
-- Safe to re-run.

-- `profiles.user_id` must be unique for a foreign key to reference it.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_user_id_key ON public.profiles (user_id);

DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('commercial_account_assignments',     'user_id',        'commercial_account_assignments_user_id_fkey'),
      ('commercial_opportunity_assignments', 'user_id',        'commercial_opportunity_assignments_user_id_fkey'),
      ('commercial_opportunity_notes',       'author_user_id', 'commercial_opportunity_notes_author_user_id_fkey'),
      ('commercial_account_notes',           'author_user_id', 'commercial_account_notes_author_user_id_fkey')
    ) AS t(tbl, col, fk)
  LOOP
    -- The existing constraint of this name points at auth.users. Renaming it
    -- out of the way frees the name for the profiles link the code asks for,
    -- and keeps referential integrity against auth.users intact.
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conname = spec.fk
         AND c.conrelid = format('public.%I', spec.tbl)::regclass
         AND confrelid = 'auth.users'::regclass
    ) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
                     spec.tbl, spec.fk, spec.fk || '_auth');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conname = spec.fk
         AND c.conrelid = format('public.%I', spec.tbl)::regclass
    ) THEN
      -- ON DELETE SET NULL: losing a login must never delete somebody's note
      -- or silently drop a team row. The record outlives the account.
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) '
        'REFERENCES public.profiles(user_id) ON DELETE SET NULL',
        spec.tbl, spec.fk, spec.col
      );
    END IF;
  END LOOP;
END $$;

-- Make PostgREST re-read the schema so the new relationships are visible
-- without waiting for a restart.
NOTIFY pgrst, 'reload schema';
