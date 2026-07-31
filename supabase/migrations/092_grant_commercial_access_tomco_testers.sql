-- 092 · Commercial-only access for the Tomco smoke-test users (2026-08).
-- Brendan Dwyer (Tomco CEO) + Stephanie Drewis.
--
-- Run this AFTER creating their accounts in Settings → Access (which upserts
-- their profile rows + gives them residential Command Center access by default).
--
-- We want them on the COMMERCIAL side ONLY, so this GRANTS the commercial
-- platform (has_new_platform_access = true) and TURNS OFF residential
-- (has_command_center_access = false). With commercial-only access the login
-- flow auto-lands them straight on /commercial — no platform picker, never the
-- PPP Command Center.
--
-- Plain UPDATE (no DO/plpgsql block, so the Supabase SQL editor runs it cleanly).
-- Idempotent + safe to re-run. Result "UPDATE 0" = the account doesn't exist yet
-- → create it in Settings → Access first, then re-run.

UPDATE public.profiles
   SET has_new_platform_access = true,
       has_command_center_access = false,
       is_active = true
 WHERE LOWER(email) IN (
   'brendan@tomcopainting.com',
   'stephanie@tomcopainting.com'
 );
