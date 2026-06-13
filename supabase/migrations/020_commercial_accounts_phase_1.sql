-- Migration 020: New Platform Phase 1 — Account Management foundation.
--
-- Adds the 4 core tables for managing commercial accounts (the "who PPP
-- works with" layer). See docs/NEW_PLATFORM_PLAN.md Phase 1 + the detailed
-- product walkthrough at docs/NEW_PLATFORM_DETAILED_PLAN.html.
--
-- Tables:
--   commercial_accounts          — companies PPP bids to or works for
--   commercial_contacts          — individual people
--   commercial_account_contacts  — junction with role + default-for flag
--   commercial_account_documents — versioned doc storage references
--
-- Soft-delete via deleted_at on accounts + contacts. Documents archive via
-- archived flag (immutable file storage; new uploads add new rows).
--
-- Audit logging is handled at application layer via lib/commercial/audit-log.ts.
-- Every commercial_* mutation logs to commercial_audit_log (migration 019).
--
-- Safe to re-run.

-- ============================================================
-- 1. commercial_accounts — the company directory
-- ============================================================
CREATE TABLE IF NOT EXISTS public.commercial_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity
  company_name TEXT NOT NULL,
  dba TEXT,
  industry TEXT,
  -- A/B/C rating (Katie's classification)
  rating TEXT CHECK (rating IN ('A', 'B', 'C')),
  -- Billing address (the AP department)
  billing_street TEXT,
  billing_city TEXT,
  billing_state TEXT,
  billing_zip TEXT,
  -- Primary site address (when different from billing)
  site_street TEXT,
  site_city TEXT,
  site_state TEXT,
  site_zip TEXT,
  -- Contact info
  phone TEXT,
  ap_phone TEXT,
  website TEXT,
  -- Compliance status — admin updates as docs come in
  vendor_compliance_status TEXT CHECK (vendor_compliance_status IN ('green', 'yellow', 'red', 'not_started')),
  prequalification_status TEXT CHECK (prequalification_status IN ('not_started', 'pending', 'approved', 'rejected')),
  -- Insurance minimums (required limits this account demands of PPP)
  insurance_min_liability NUMERIC,
  insurance_min_workers_comp NUMERIC,
  -- Tax
  tax_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  tax_exempt_cert_number TEXT,
  -- Free-form internal notes
  notes TEXT,
  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS commercial_accounts_company_name_idx
  ON public.commercial_accounts (LOWER(company_name));
CREATE INDEX IF NOT EXISTS commercial_accounts_rating_idx
  ON public.commercial_accounts (rating)
  WHERE rating IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commercial_accounts_active_idx
  ON public.commercial_accounts (created_at DESC)
  WHERE deleted_at IS NULL;

-- ============================================================
-- 2. commercial_contacts — individual people
-- ============================================================
CREATE TABLE IF NOT EXISTS public.commercial_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS commercial_contacts_email_idx
  ON public.commercial_contacts (LOWER(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commercial_contacts_name_idx
  ON public.commercial_contacts (LOWER(full_name))
  WHERE deleted_at IS NULL;

-- ============================================================
-- 3. commercial_account_contacts — junction with role
-- ============================================================
-- A contact can be on multiple accounts; an account can have multiple
-- contacts; the SAME person can have multiple roles on the SAME account
-- (e.g. both Decision Maker AND Billing Contact). The UNIQUE constraint
-- on (account, contact, role) lets that happen via multiple rows.
CREATE TABLE IF NOT EXISTS public.commercial_account_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.commercial_contacts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN (
    'decision_maker', 'estimator', 'pm', 'superintendent',
    'ap', 'billing', 'site', 'other'
  )),
  -- Optional flag — which workflow does this contact default to?
  -- e.g. 'bid' = gets the bid emails; 'invoice' = gets invoices.
  is_default_for TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, contact_id, role)
);

CREATE INDEX IF NOT EXISTS commercial_account_contacts_account_idx
  ON public.commercial_account_contacts (account_id);
CREATE INDEX IF NOT EXISTS commercial_account_contacts_contact_idx
  ON public.commercial_account_contacts (contact_id);

-- ============================================================
-- 4. commercial_account_documents — versioned doc references
-- ============================================================
-- Files live in Supabase Storage (bucket: commercial-documents). Rows
-- here are the metadata + immutable storage_key references. New uploads
-- get a new row + version_n + leave the old row in place (archived flag
-- flips on the prior row). That way historical project rev's docs still
-- resolve.
CREATE TABLE IF NOT EXISTS public.commercial_account_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'coi', 'w9', 'master_agreement', 'vendor_onboarding', 'safety', 'other'
  )),
  file_name TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  size_bytes INTEGER,
  uploaded_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Expiration tracking (COI / insurance certs in particular)
  expires_at TIMESTAMPTZ,
  -- When a newer version supersedes this row.
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS commercial_account_documents_account_idx
  ON public.commercial_account_documents (account_id, category)
  WHERE archived = FALSE;

-- Expiring-soon index for the alert system (insurance/COI within 30d).
CREATE INDEX IF NOT EXISTS commercial_account_documents_expiring_idx
  ON public.commercial_account_documents (expires_at)
  WHERE expires_at IS NOT NULL AND archived = FALSE;

-- ============================================================
-- 5. updated_at trigger — keep updated_at fresh on every row mutation
-- ============================================================
-- One generic trigger reused across tables; idempotent CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.tg_commercial_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commercial_accounts_set_updated_at ON public.commercial_accounts;
CREATE TRIGGER commercial_accounts_set_updated_at
  BEFORE UPDATE ON public.commercial_accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

DROP TRIGGER IF EXISTS commercial_contacts_set_updated_at ON public.commercial_contacts;
CREATE TRIGGER commercial_contacts_set_updated_at
  BEFORE UPDATE ON public.commercial_contacts
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();
