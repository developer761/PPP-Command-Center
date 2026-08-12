-- 130: remember when a person TYPED the contract sum on an AIA application.
--
-- The AIA settings form has an "Original Contract Sum" field. It saves. It is
-- then ignored: the contract ladder ranks the proposal above it, so whenever the
-- deal has any proposal at all — which is nearly always — the tile and the G702
-- keep showing the proposal-derived figure and the operator's correction
-- silently does nothing.
--
-- That field exists precisely for the case where the proposal is NOT the right
-- number: a contract signed at a negotiated figure, a legacy job, a correction
-- from the GC. Someone typing there has better information than the ladder does.
--
-- We can't tell a typed value from a defaulted one after the fact —
-- `original_contract_cents` is force-set to the seeded schedule-of-values total
-- at creation, so every application has a plausible-looking number in it. Hence
-- a flag rather than a heuristic.
--
-- Existing rows default to false: they keep behaving exactly as they do today,
-- and start honouring the field the first time someone edits it.
--
-- Safe to re-run.

ALTER TABLE public.commercial_aia_applications
  ADD COLUMN IF NOT EXISTS original_contract_is_manual BOOLEAN NOT NULL DEFAULT false;
