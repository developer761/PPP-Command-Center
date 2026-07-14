-- Phase F.5 (Karan 2026-07-14) — per-proposal one-off exclusions.
--
-- Alex needs to add customer-specific exclusions ("Rain days extend
-- timeline for this Peekskill project") without polluting the shared
-- Exclusions Library used by every future proposal. This column stores
-- text-only exclusions that belong to a single proposal.
--
-- PDF renderer merges: exclusion_ids (from library, ordered) followed by
-- custom_exclusions (this-proposal-only text, ordered as added).
--
-- Idempotent: safe to re-paste. Existing proposals default to an empty
-- array so no data migration needed.

ALTER TABLE commercial_proposals
  ADD COLUMN IF NOT EXISTS custom_exclusions TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN commercial_proposals.custom_exclusions IS
  'Per-proposal ad-hoc exclusion text lines that do NOT belong to the shared exclusion library. Rendered on the PDF after the library-resolved exclusion_ids, in the order Alex added them. Free-form text; validated only for max length in the app layer.';
