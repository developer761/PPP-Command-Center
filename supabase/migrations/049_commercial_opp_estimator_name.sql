-- Migration 049 — Commercial Opportunity manual-estimator support.
--
-- Karan 2026-07-10: "give me an option for manual entry for estimator
-- wherever it is." Not every estimator on a bid is on the team roster
-- (subs, ex-employees handling one bid, GC-supplied estimators). Add a
-- nullable TEXT column so the UI can capture a free-text name without
-- forcing the user to invent a fake auth.users row.
--
-- Precedence at read time (application-layer): if `estimator_name` is
-- non-null + non-empty, display it as-is. Otherwise, look up
-- `estimator_user_id` against auth.users for the real user name.
-- Only ONE of these should be set per opportunity — the UI enforces
-- "picking from the dropdown clears the text field" and vice versa,
-- but the DB stores both to preserve history if a user typo-ed a
-- team member's name before being told to use the picker.
--
-- Status-transition validator (lib/commercial/opportunities/status.ts)
-- was updated in the same PR to accept EITHER estimator_user_id OR a
-- non-empty estimator_name for the "estimating+" structural-fields
-- gate — so manual entries can move through the funnel like any
-- team-assigned estimator.
--
-- Idempotent + rerun-safe.

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS estimator_name TEXT;

COMMENT ON COLUMN public.commercial_opportunities.estimator_name IS
  'Free-text estimator name for cases where the estimator is not on the
   PPP team roster (subs, GC-supplied estimators, ex-employees on one
   bid). Takes display precedence over estimator_user_id if both are
   set. Nullable — one of estimator_user_id OR estimator_name is
   sufficient for the estimating+ transition guard. Added migration
   049 per Karan 2026-07-10.';
