-- 074_last_admin_guard.sql
-- Atomic "never zero active admins" invariant.
--
-- The application already guards this in lib/auth/user-management.ts, but that
-- is a read-then-write (SELECT count, then UPDATE) with a race: two concurrent
-- requests each demoting/deactivating a different admin can both read count=2
-- and both commit, leaving zero admins. This BEFORE UPDATE trigger closes it at
-- the database, with an advisory transaction lock so concurrent admin-removals
-- serialize and the count can't be read stale.

CREATE OR REPLACE FUNCTION public.prevent_last_admin_removal()
RETURNS TRIGGER AS $$
BEGIN
  -- Only when this row WAS a counted active admin and is about to stop being one.
  IF (OLD.role = 'admin' AND OLD.is_active = TRUE)
     AND (NEW.role <> 'admin' OR NEW.is_active = FALSE) THEN
    -- Serialize concurrent admin-removals: the 2nd waits for the 1st to commit,
    -- so its count reflects the 1st change instead of a stale snapshot.
    PERFORM pg_advisory_xact_lock(hashtext('ppp_last_admin_guard'));
    IF (
      SELECT count(*) FROM public.profiles
      WHERE role = 'admin' AND is_active = TRUE AND user_id <> OLD.user_id
    ) < 1 THEN
      RAISE EXCEPTION 'Cannot remove the last active admin';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_last_admin_removal ON public.profiles;
CREATE TRIGGER trg_prevent_last_admin_removal
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_last_admin_removal();
