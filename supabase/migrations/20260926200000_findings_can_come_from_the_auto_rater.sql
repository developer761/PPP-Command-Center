-- A finding can now come from the auto-rater.
--
-- 20260924114500 introduced `basis` with Kate's six values and said, in its
-- own comment, why it is a CHECK rather than a lookup table:
--
--   "A CHECK rather than a lookup table because it is six values that
--    describe how a human graded something, and a new one should be a
--    DECISION SOMEBODY MAKES rather than a row that appears."
--
-- This is that decision. The auto-rater (Iteration 1 spec, "Two internal
-- builds") rates every Hub conversation as it finishes, and its findings have
-- to be distinguishable from Kate's at a glance — verify-surfaces already
-- pins her baselines to her own import batch, and mixing a machine's findings
-- into figures the spec is written against would break that silently.
--
-- The existing vocabulary separates a judgement (read) from a measurement
-- (detector). 'auto_rater' is a third kind: a machine judgement, which is
-- neither, and which a person is expected to validate or adjust before it is
-- trusted. Spec: "A person then validates that rating or adjusts it, naming
-- the rule that should have applied instead."
--
-- ── THE CONSTRAINT NAME IS READ, NOT GUESSED ───────────────────────────
--
-- sms_example_findings_basis_known, taken from 20260924114500 line 56.
--
-- Saying that explicitly because the last migration in this series did guess.
-- It dropped sms_scheduled_actions_action_CHECK when the live constraint was
-- sms_scheduled_actions_action_CHK, so the DROP matched nothing, the ADD
-- created a second constraint, and the original kept rejecting every insert
-- while the sweep reported queued: 0. Verified here by probing first:
-- basis='auto_rater' fails 23514 today, basis='read' and NULL both succeed,
-- so it is this constraint and this column.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sms_example_findings_basis_known'
  ) THEN
    ALTER TABLE public.sms_example_findings
      DROP CONSTRAINT sms_example_findings_basis_known;
  END IF;
END $$;

ALTER TABLE public.sms_example_findings
  ADD CONSTRAINT sms_example_findings_basis_known
  CHECK (basis IS NULL OR basis IN (
    'read', 'detector', 'read + detector', 'lookup', 'carve', 'day lookup',
    'auto_rater'
  ));

COMMENT ON COLUMN public.sms_example_findings.basis IS
  'How the finding was reached: read (a person), detector (a mechanical '
  'check), read + detector, or lookup/carve/day lookup for rules decided by a '
  'table. Separates a judgement from a measurement. auto_rater is a third '
  'kind — a machine judgement, pending a person''s validation — and is the '
  'value that keeps the Hub''s own findings out of figures computed against '
  'Kate''s shipped corpus.';
