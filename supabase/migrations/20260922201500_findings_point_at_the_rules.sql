-- Findings point at the RULES, not at a second copy of the rule codes.
--
-- There are two tables holding Kate's A-codes:
--
--   sms_audit_codes     29 codes, from migration 200, with a short name each
--   sms_class_a_rules   44 codes, her full rule set, with the statement, the
--                       rule card, the corrective action, severity, status and
--                       provenance
--
-- The second is a superset of the first — every one of the 29 is in the 44 —
-- and is the one she maintains. sms_example_findings.code still referenced the
-- 29, which is fine for the 192 findings already imported and breaks the
-- moment her next file arrives: it grades against A1, A35, A38, A40 and eleven
-- other codes that exist only in the newer table, and every one of those
-- findings would be refused by the foreign key.
--
-- So the constraint moves to the authoritative table. Nothing about the
-- existing rows changes — their codes are in both — and the join Kate actually
-- wants ("show me the good and the bad turns for A22") now has one place to
-- resolve a code rather than two that can disagree.
--
-- The short names are worth keeping, so they move across rather than being
-- lost with the table they came from.
--
-- Safe to re-run.

-- ── The short name, where the rule set has no equivalent ─────────────────
ALTER TABLE public.sms_class_a_rules
  ADD COLUMN IF NOT EXISTS short_name TEXT;

COMMENT ON COLUMN public.sms_class_a_rules.short_name IS
  'Kate''s own short label for the rule ("Redundant Ask", "Service Area"), from sms_audit_codes. The statement is the rule; this is what fits in a column heading.';

UPDATE public.sms_class_a_rules r
   SET short_name = c.name
  FROM public.sms_audit_codes c
 WHERE c.code = r.code
   AND r.short_name IS NULL
   AND btrim(coalesce(c.name, '')) <> '';

-- ── The constraint ──────────────────────────────────────────────────────
--
-- ON DELETE SET NULL, matching what it replaces: a finding whose rule is
-- deleted is still evidence about a conversation, and losing the finding would
-- be worse than losing which rule it was filed under. Retired rules are kept
-- rather than deleted anyway, so this should never fire.
ALTER TABLE public.sms_example_findings
  DROP CONSTRAINT IF EXISTS sms_example_findings_code_fkey;

ALTER TABLE public.sms_example_findings
  ADD CONSTRAINT sms_example_findings_code_fkey
  FOREIGN KEY (code) REFERENCES public.sms_class_a_rules(code) ON DELETE SET NULL;

-- The query Kate's screen makes: every finding for one rule, newest first.
CREATE INDEX IF NOT EXISTS sms_example_findings_code_kind_idx
  ON public.sms_example_findings (code, kind, created_at DESC)
  WHERE code IS NOT NULL;
