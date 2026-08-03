-- 110 · R7 — one-time Commercial onboarding walkthrough.
--
-- A single nullable timestamp per user. NULL = hasn't seen the walkthrough yet
-- (so EVERY existing logged-in user sees it once on their next visit, then it's
-- stamped and never shows again). Scoped to the Commercial platform on purpose —
-- the residential Command Center is unaffected.

alter table public.profiles
  add column if not exists commercial_onboarding_seen_at timestamptz;
