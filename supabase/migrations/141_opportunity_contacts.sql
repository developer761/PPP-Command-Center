-- 141 — contacts on the JOB, not only on the customer.
--
-- Stephanie 2026-08-13: "New Opportunity > Add contact to opportunity — right
-- now there is only account contacts, each job may have different contacts for
-- site supers, pms, apms, estimators, etc. Add many spaces."
--
-- She is describing how commercial work actually runs. The account's contacts
-- are the GC's office — estimating, AP, the person who sends bid invites. The
-- people you deal with once a job starts are assigned per project: this site's
-- superintendent, this job's PM. They change between jobs at the same GC, and
-- they change DURING a job. Holding them only on the account means either the
-- account list becomes a pile of everyone who ever ran a job for that builder,
-- or the site super simply is not recorded anywhere.
--
-- Shape mirrors commercial_account_contacts deliberately:
--   * the PERSON stays in commercial_contacts and is reused, so the same
--     superintendent across three jobs is one record with one phone number,
--     not three that drift apart
--   * the ROLE lives on the link, because the same person is a PM here and a
--     superintendent there
--   * UNIQUE (opportunity, contact, role) so one person can hold two roles on
--     one job without needing two contact records
--
-- `is_primary` is the "Attention" contact — the one the proposal is addressed
-- to (Stephanie: "Attention Contact? How do I edit that"). Enforced as at most
-- one per job by a partial unique index rather than by app code, because two
-- primaries is the kind of thing that only shows up on a printed proposal.

CREATE TABLE IF NOT EXISTS public.commercial_opportunity_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.commercial_contacts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN (
    'decision_maker', 'estimator', 'pm', 'apm', 'superintendent',
    'ap', 'billing', 'site', 'other'
  )),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (opportunity_id, contact_id, role)
);

CREATE INDEX IF NOT EXISTS commercial_opportunity_contacts_opp_idx
  ON public.commercial_opportunity_contacts (opportunity_id);
CREATE INDEX IF NOT EXISTS commercial_opportunity_contacts_contact_idx
  ON public.commercial_opportunity_contacts (contact_id);

-- At most one "Attention" contact per job.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_opportunity_contacts_primary_idx
  ON public.commercial_opportunity_contacts (opportunity_id)
  WHERE is_primary;

-- The account junction gains 'apm' too, so the role vocabulary is ONE list
-- rather than two that drift. Migration 136 exists because a role list in the
-- app and a CHECK in the database disagreed, and three of four roles were
-- silently rejected at save time for as long as that lasted.
ALTER TABLE public.commercial_account_contacts
  DROP CONSTRAINT IF EXISTS commercial_account_contacts_role_check;
ALTER TABLE public.commercial_account_contacts
  ADD CONSTRAINT commercial_account_contacts_role_check CHECK (role IN (
    'decision_maker', 'estimator', 'pm', 'apm', 'superintendent',
    'ap', 'billing', 'site', 'other'
  ));

COMMENT ON TABLE public.commercial_opportunity_contacts IS
  'Per-job contacts (site super, PM, APM...). The person lives in commercial_contacts and is reused; the role lives on this link. is_primary = the proposal "Attention" contact.';
