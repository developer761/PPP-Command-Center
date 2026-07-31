-- 092 · Commercial-only access for the Tomco smoke-test users (2026-08).
-- Brendan Dwyer (Tomco CEO) + Stephanie Drewis.
--
-- Run this AFTER creating their accounts in Settings → Access (which upserts
-- their profile rows + gives them residential Command Center access by default).
--
-- We want them on the COMMERCIAL side ONLY — so this both GRANTS the commercial
-- platform (has_new_platform_access = true) and TURNS OFF residential
-- (has_command_center_access = false). With commercial-only access the login
-- flow auto-lands them straight on /commercial (no platform picker, never the
-- PPP Command Center).
--
-- Idempotent + safe to re-run. If a profile row isn't there yet (account not
-- created), it updates 0 rows — create the account, then re-run.

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
         has_command_center_access = false,
         is_active = true
   WHERE LOWER(email) = ANY(target_emails);
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE '[092] Tomco testers set to Commercial-only (rows changed: %)', updated_count;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE LOWER(email) = 'brendan@tomcopainting.com') THEN
    RAISE NOTICE '[092] NOTE — no account yet for brendan@tomcopainting.com (create it in Settings → Access, then re-run)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE LOWER(email) = 'stephanie@tomcopainting.com') THEN
    RAISE NOTICE '[092] NOTE — no account yet for stephanie@tomcopainting.com (create it in Settings → Access, then re-run)';
  END IF;
END $$;
