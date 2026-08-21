-- 161 · Capital Improvement as a sales-tax option on the job. (Stephanie, 2026-08-17)
--
-- HER NOTE: "Opportunity > Sales Tax options - add Capital Improvement", and
-- in the later round: "Overall sales tax is a little wacky."
--
-- WHY IT FELT WACKY. There were TWO controls, in two places, for one decision:
--
--   1. The job's sales-tax select (Follow the customer / Exempt / Taxable),
--      which decides whether tax is charged.
--   2. A "Capital Improvement" checkbox buried in the PROPOSAL editor, which
--      only printed the yellow notice line on the PDF.
--
-- So a capital-improvement job had to be set exempt in one screen and ticked
-- as capital improvement in another, and nothing connected them. Tick only the
-- notice and the invoice still charged tax; set only exempt and the proposal
-- went out without the line NY requires.
--
-- WHAT THIS ADDS. The REASON alongside the existing boolean, not a replacement
-- for it. `tax_exempt` stays the single authoritative "is this job taxed" —
-- 39 call sites across invoices, change orders, AIA and the sales-tax report
-- read it, and re-pointing all of them at a new enum is a money-wide refactor
-- for a label. This records WHY it is exempt, which is the part that was
-- missing and the part that drives the proposal notice.
--
--   null                  → not exempt, or exempt for an unrecorded reason
--   'certificate'         → ST-119.1 exemption certificate on file
--   'capital_improvement' → ST-124 capital improvement
--
-- Both mean "charge no tax". They are not interchangeable on paper: a
-- certificate is the customer's status, a capital improvement is the nature of
-- the WORK. The sales-tax report already separates certified from uncertified
-- and can now say which of the two applies instead of inferring it.

ALTER TABLE commercial_opportunities
  ADD COLUMN IF NOT EXISTS tax_exempt_reason text;

ALTER TABLE commercial_opportunities
  DROP CONSTRAINT IF EXISTS commercial_opportunities_tax_exempt_reason_check;

ALTER TABLE commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_tax_exempt_reason_check
  CHECK (tax_exempt_reason IS NULL OR tax_exempt_reason IN ('certificate', 'capital_improvement'));

COMMENT ON COLUMN commercial_opportunities.tax_exempt_reason IS
  'Why this job is exempt: certificate (ST-119.1) or capital_improvement (ST-124). NULL when taxable or unrecorded. tax_exempt remains the authoritative "is it taxed" flag.';

-- Existing exempt jobs carry a certificate number, so they are certificate
-- exemptions. Nothing on file is left NULL rather than guessed — an exemption
-- with no recorded basis is exactly what the sales-tax report is meant to flag.
UPDATE commercial_opportunities
   SET tax_exempt_reason = 'certificate'
 WHERE tax_exempt IS TRUE
   AND tax_exempt_reason IS NULL
   AND coalesce(trim(tax_exempt_cert_number), '') <> '';
