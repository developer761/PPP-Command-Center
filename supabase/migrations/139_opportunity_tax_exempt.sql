-- 139 — tax exemption can follow the job, not just the customer.
--
-- Stephanie 2026-08-13: "Account > tax exemption follows opportunity not
-- account."
--
-- She is right, and it matters in New York specifically: an exemption
-- certificate is issued for a PROJECT. The same GC can be exempt on a school
-- or municipal job and fully taxable on the private job next door, and a
-- capital-improvement job carries its own certificate regardless of who the
-- customer is. Holding the flag only on the account meant one of those two
-- jobs was always billed wrong.
--
-- Deliberately NULLABLE, and that is the whole design:
--
--   null   → inherit the account's setting (today's behaviour, unchanged)
--   true   → this job is exempt, whatever the account says
--   false  → this job is taxable, even though the account is exempt
--
-- A plain boolean defaulting to false would silently make every existing
-- opportunity "not exempt" and start charging tax to exempt customers on the
-- next invoice. The three-state column means nothing changes until someone
-- deliberately sets it on a job.

alter table commercial_opportunities
  add column if not exists tax_exempt boolean,
  add column if not exists tax_exempt_cert_number text;

comment on column commercial_opportunities.tax_exempt is
  'Per-job tax exemption. NULL inherits the account; true/false overrides it for this job only. NY exemption certificates are issued per project.';
comment on column commercial_opportunities.tax_exempt_cert_number is
  'Exemption certificate number for THIS job, when it differs from the account''s.';
