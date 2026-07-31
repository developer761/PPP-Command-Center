-- 092 · Grant Commercial Command Center access to the Tomco smoke-test users
-- (2026-08). Brendan Dwyer (Tomco CEO) + Stephanie Drewis.
--
-- Run this AFTER creating their accounts in Settings → Access (which upserts
-- their profile rows). This flips the one flag that gates the Commercial
-- platform — `profiles.has_new_platform_access` — plus keeps them active.
-- Roles are open (everyone has full access for now), so no role row is needed
-- for access; RBAC can be layered later.
--
-- Idempotent + safe to re-run. Only sets flags TRUE; never downgrades. If a
-- profile row isn't there yet (account not created), it simply updates 0 rows
-- for that email — create the account, then re-run.

DO $$
DECLARE
  target_emails text[] := ARRAY[
    'brendan@tomcopainting.com',
    'stephanie@tomcopainting.com'
  ];
  updated_count int;
BEGIN
  UPDATE public.profiles
     SET has_new_platform_access = true,
         is_active = true
   WHERE LOWER(email) = ANY(target_emails)
     AND (has_new_platform_access = false OR is_active = false OR has_new_platform_access IS NULL);
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE '[092] Tomco testers granted Commercial access (rows changed: %)', updated_count;

  -- Report any email that has no profile row yet, so you know to create it in
  -- Settings → Access first, then re-run.
  PERFORM 1;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE LOWER(email) = 'brendan@tomcopainting.com') THEN
    RAISE NOTICE '[092] NOTE — no account yet for brendan@tomcopainting.com (create it in Settings → Access, then re-run)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE LOWER(email) = 'stephanie@tomcopainting.com') THEN
    RAISE NOTICE '[092] NOTE — no account yet for stephanie@tomcopainting.com (create it in Settings → Access, then re-run)';
  END IF;
END $$;
