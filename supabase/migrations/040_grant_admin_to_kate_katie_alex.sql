-- 040_grant_admin_to_kate_katie_alex.sql
-- 2026-06-29: grant full admin on BOTH platforms (PPP CC + Commercial CC) to
-- Kate Sutton, Katie Batilla, and Alex Z. Karan flagged Kate didn't have admin
-- access yet — bringing all three onto the same footing.
--
-- This script is idempotent (safe to re-run). It does FOUR things per email:
--   1. flips profiles.is_admin = true
--   2. flips profiles.has_new_platform_access = true
--   3. flips profiles.is_active = true (defensive; restores any soft-deactivated row)
--   4. ensures commercial_user_roles has a 'admin' row for the user
--
-- Email matching is LOWER() + handles both .net and .com domains because
-- PPP isn't standardized on the suffix. We don't touch other rows.
--
-- Pre-req: the profile row must already exist for each user (created on
-- their first sign-in). If a row is missing for one of these emails, the
-- UPDATE is a no-op for that email — they'll need to sign in once, then
-- re-run this script. The script reports the row count at the end so you
-- can verify how many landed.

DO $$
DECLARE
  target_emails text[] := ARRAY[
    'k.sutton@precisionpaintingplus.net',
    'k.sutton@precisionpaintingplus.com',
    'katie@precisionpaintingplus.com',
    'katie@precisionpaintingplus.net',
    'alex@precisionpaintingplus.com',
    'alex@precisionpaintingplus.net'
  ];
  updated_count int;
  roles_added_count int := 0;
  email_norm text;
  user_uuid uuid;
BEGIN
  -- 1+2+3: flip the three profile flags in one UPDATE.
  UPDATE profiles
     SET is_admin = true,
         has_new_platform_access = true,
         is_active = true
   WHERE LOWER(email) = ANY(target_emails);
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE '[040] profiles updated (is_admin + has_new_platform_access + is_active): %', updated_count;

  -- 4: ensure each user has a commercial_user_roles admin row.
  -- Looping so we can report which emails landed vs. were skipped because
  -- the profile row wasn't there yet.
  FOREACH email_norm IN ARRAY target_emails LOOP
    SELECT user_id INTO user_uuid FROM profiles WHERE LOWER(email) = email_norm LIMIT 1;
    IF user_uuid IS NULL THEN
      RAISE NOTICE '[040] SKIP — no profile row yet for %: ask them to sign in once, then re-run', email_norm;
      CONTINUE;
    END IF;
    -- Idempotent insert. commercial_user_roles has a UNIQUE (user_id, role)
    -- constraint per migration 019; ON CONFLICT DO NOTHING is safe.
    INSERT INTO commercial_user_roles (user_id, role)
    VALUES (user_uuid, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
    IF FOUND THEN
      roles_added_count := roles_added_count + 1;
      RAISE NOTICE '[040] commercial admin role added for % (%)', email_norm, user_uuid;
    ELSE
      RAISE NOTICE '[040] commercial admin role already present for %', email_norm;
    END IF;
  END LOOP;

  RAISE NOTICE '[040] DONE — profile flips: %, commercial-admin roles added: %',
    updated_count, roles_added_count;
END $$;

-- Verification query — run this after to eyeball the result:
-- SELECT p.email, p.is_admin, p.has_new_platform_access, p.is_active,
--        EXISTS (SELECT 1 FROM commercial_user_roles r WHERE r.user_id = p.user_id AND r.role = 'admin') AS has_commercial_admin
--   FROM profiles p
--  WHERE LOWER(p.email) IN (
--    'k.sutton@precisionpaintingplus.net','k.sutton@precisionpaintingplus.com',
--    'katie@precisionpaintingplus.com','katie@precisionpaintingplus.net',
--    'alex@precisionpaintingplus.com','alex@precisionpaintingplus.net'
--  );
