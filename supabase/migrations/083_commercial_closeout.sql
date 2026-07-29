-- Migration 083: Closeout & Warranty (post-contract lifecycle tail).
--
-- A close-out PACKAGE is a Letter-of-Transmittal cover + a checklist of
-- close-out items (as-builts, O&M manuals, warranties, lien/final waivers,
-- final invoice, punchlist sign-off, COI) that PPP sends to the GC when a job
-- finishes — plus the project's WARRANTY details (substantial-completion date +
-- term), which drive a generated warranty letter.
--
-- One package per opportunity (revisable via status/void, like submittals/AIA).
-- Mirrors the submittals + AIA conventions: status DAG, soft-delete via voided_at,
-- audit through the app layer, service-role-only RLS (all commercial data is
-- reached through the service-role client behind assertCommercialAccess).
--
-- Idempotent: IF NOT EXISTS throughout; safe to re-run.

CREATE TABLE IF NOT EXISTS public.commercial_closeout_packages (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id            UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,
  account_id                UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE CASCADE,

  -- Transmittal cover (same shape as a submittal cover).
  status                    TEXT NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','sent','acknowledged','complete','voided')),
  to_company                TEXT,
  to_attention              TEXT,
  to_address_lines          TEXT[],
  re_subject                TEXT,
  transmitted_as            TEXT
                              CHECK (transmitted_as IS NULL OR transmitted_as IN
                                     ('for_approval','for_your_records','as_requested','for_review')),
  remarks                   TEXT,

  -- Warranty.
  substantial_completion_date DATE,
  warranty_years            INT NOT NULL DEFAULT 2 CHECK (warranty_years >= 0 AND warranty_years <= 20),

  -- Lifecycle timestamps + the frozen sent PDF.
  sent_at                   TIMESTAMPTZ,
  acknowledged_at           TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  snapshot_document_id      UUID,

  -- Soft-delete + audit.
  voided_at                 TIMESTAMPTZ,
  voided_by_user_id         UUID,
  void_reason               TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id        UUID,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id        UUID
);

CREATE INDEX IF NOT EXISTS idx_closeout_pkg_opp
  ON public.commercial_closeout_packages(opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_closeout_pkg_account
  ON public.commercial_closeout_packages(account_id);
CREATE INDEX IF NOT EXISTS idx_closeout_pkg_status
  ON public.commercial_closeout_packages(status);

CREATE TABLE IF NOT EXISTS public.commercial_closeout_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id    UUID NOT NULL REFERENCES public.commercial_closeout_packages(id) ON DELETE CASCADE,
  position      INT  NOT NULL DEFAULT 0,
  -- Canonical close-out doc kinds + free-form 'other'.
  kind          TEXT NOT NULL DEFAULT 'other'
                  CHECK (kind IN ('as_built','om_manual','warranty','lien_waiver',
                                  'final_invoice','punchlist_signoff','coi','other')),
  label         TEXT,
  -- included = will be in the package; status = collection state.
  included      BOOLEAN NOT NULL DEFAULT TRUE,
  item_status   TEXT NOT NULL DEFAULT 'pending'
                  CHECK (item_status IN ('pending','received','na')),
  document_id   UUID,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_closeout_item_pkg
  ON public.commercial_closeout_items(package_id, position);

-- RLS: service-role only (matches every other commercial_* table).
ALTER TABLE public.commercial_closeout_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_closeout_items    ENABLE ROW LEVEL SECURITY;

DO $rls$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'commercial_closeout_packages' AND policyname = 'closeout_pkg_service_role') THEN
    CREATE POLICY closeout_pkg_service_role ON public.commercial_closeout_packages
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'commercial_closeout_items' AND policyname = 'closeout_item_service_role') THEN
    CREATE POLICY closeout_item_service_role ON public.commercial_closeout_items
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END
$rls$;
