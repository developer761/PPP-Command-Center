-- PPP Commercial Command Center — pending production migrations
-- Paste this whole file into the Supabase SQL editor and Run. Idempotent + safe to re-run.
-- Contains: 082 (account-overview view v2 status) · 083 (closeout) · 084 (sales tax).

-- ========== 082 ==========
-- Migration 082: recreate commercial_account_overview_v against the V2 status
-- model. Migration 052 moved every opp off the V1 vocabulary (inquiry /
-- proposal_sent / won / lost / no_bid → pre_sale_closed+sub_status, qualifying,
-- proposal, etc.), but this view (last defined in 033) still filtered on the DEAD
-- V1 values — so Account 360's Won / Lost / Open-bids / Bid-range tiles were
-- ALWAYS wrong (Won=0 for every account). Now uses V2 semantics:
--   open_opps_count / bid range → status IN (qualifying, estimating, proposal)
--   won_opps_count  → won at ANY stage (pre_sale_closed+won OR pre_construction
--                     / in_progress / billing / post_sale_closed) — matches
--                     isPostSaleProject, so advanced/delivered wins still count
--   lost_opps_count → pre_sale_closed + sub_status='lost'
--   avg_days_to_close → just-won (pre_sale_closed+won) with decided_at (reliable)
-- CREATE OR REPLACE VIEW keeps the exact column order/names from 033; only the
-- WHERE filters changed. Safe to re-run.
--
-- ── Original 033 header (retained for column reference) ──
-- Migration 033: Phase 2 Batch 5 — Account-side opportunity rollups.
--
-- Extends commercial_account_overview_v with opportunity aggregates so
-- the Account 360 page can finally render real numbers in the "Total
-- bid" + "Open opps" KPI tiles that have been "Coming with Phase 2"
-- placeholders since migration 024.
--
-- New columns (append-only — see migration 027's header for why we can't
-- rename or reorder existing columns via CREATE OR REPLACE VIEW):
--   open_opps_count                       — INT, opps in any of
--                                            inquiry / site_visit_scheduled
--                                            / site_visit_done /
--                                            estimating / proposal_sent /
--                                            negotiating / on_hold
--                                            (matches OPEN_OPP_STATUSES in
--                                            lib/commercial/opportunities/constants.ts)
--   total_active_bid_low_cents            — BIGINT, SUM of bid_value_low_cents
--                                            across open opps (NULL when none)
--   total_active_bid_high_cents           — BIGINT, SUM of bid_value_high_cents
--                                            across open opps (NULL when none)
--   won_opps_count                        — INT, all-time count of status='won'
--   lost_opps_count                       — INT, all-time count of status IN
--                                            ('lost', 'no_bid')
--   last_opp_activity_at                  — TIMESTAMPTZ, MAX(updated_at) across
--                                            all opps for this account
--   avg_days_to_close                     — NUMERIC, average decided_at minus
--                                            created_at across won opps.
--                                            Negative deltas (data integrity
--                                            edge) clamped to 0 via GREATEST.
--                                            NULL when zero won opps.
--
-- Also: last_activity_at GREATEST chain extended to include opp updates
-- so the Accounts list activity sort reflects opp work, not just
-- contacts/docs/team. Soft-deleted opps excluded everywhere.
--
-- Safe to re-run (CREATE OR REPLACE VIEW + no DDL on tables).

CREATE OR REPLACE VIEW public.commercial_account_overview_v AS
SELECT
  a.id AS account_id,

  -- ════════════════════════════════════════════════════════════════
  -- Columns 1-8: existing — do NOT reorder. CREATE OR REPLACE VIEW
  -- forbids column rename, so every column 1:1 with migration 027.
  -- ════════════════════════════════════════════════════════════════

  COALESCE((
    SELECT COUNT(DISTINCT contact_id)
      FROM public.commercial_account_contacts
     WHERE account_id = a.id
  ), 0) AS contact_count,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_account_assignments
     WHERE account_id = a.id
       AND removed_at IS NULL
  ), 0) AS ppp_team_count,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_account_documents
     WHERE account_id = a.id
       AND archived = FALSE
  ), 0) AS active_document_count,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_account_documents
     WHERE account_id = a.id
       AND archived = FALSE
       AND expires_at IS NOT NULL
       AND expires_at < NOW()
  ), 0) AS expired_document_count,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_account_documents
     WHERE account_id = a.id
       AND archived = FALSE
       AND expires_at IS NOT NULL
       AND expires_at >= NOW()
       AND expires_at < NOW() + INTERVAL '30 days'
  ), 0) AS expiring_soon_document_count,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_account_documents
     WHERE account_id = a.id
  ), 0) AS document_count_total,

  -- v3: extended to include opp.updated_at so the activity sort moves
  -- when Sarah-from-St.-Joseph's-bid changes status.
  GREATEST(
    a.updated_at,
    a.created_at,
    COALESCE((SELECT MAX(created_at)        FROM public.commercial_account_contacts    WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(last_contacted_at) FROM public.commercial_account_contacts    WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(uploaded_at)       FROM public.commercial_account_documents   WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(assigned_at)       FROM public.commercial_account_assignments WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(updated_at)        FROM public.commercial_opportunities      WHERE account_id = a.id AND deleted_at IS NULL), a.created_at)
  ) AS last_activity_at,

  -- ════════════════════════════════════════════════════════════════
  -- Columns 9-15: Phase 2 Batch 5 (append-only).
  -- ════════════════════════════════════════════════════════════════

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND status IN ('qualifying', 'estimating', 'proposal')
  ), 0) AS open_opps_count,

  -- NULL signal (no bids yet) vs 0 (bids exist but all priced at 0). We
  -- preserve the distinction by NOT wrapping the SUM in COALESCE(..., 0).
  (
    SELECT SUM(bid_value_low_cents)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND status IN ('qualifying', 'estimating', 'proposal')
       AND bid_value_low_cents IS NOT NULL
  ) AS total_active_bid_low_cents,

  (
    SELECT SUM(bid_value_high_cents)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND status IN ('qualifying', 'estimating', 'proposal')
       AND bid_value_high_cents IS NOT NULL
  ) AS total_active_bid_high_cents,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND ((status = 'pre_sale_closed' AND sub_status = 'won') OR status IN ('pre_construction', 'in_progress', 'billing', 'post_sale_closed'))
  ), 0) AS won_opps_count,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND status = 'pre_sale_closed' AND sub_status = 'lost'
  ), 0) AS lost_opps_count,

  (
    SELECT MAX(updated_at)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
  ) AS last_opp_activity_at,

  -- Average days from create to decided for won opps. decided_at is set
  -- by changeOpportunityStatus when transitioning to won/lost/no_bid;
  -- GREATEST(..., 0) defends against the (rare) clock-skew or data-fix
  -- case where decided_at predates created_at.
  (
    SELECT AVG(GREATEST(EXTRACT(EPOCH FROM (o.decided_at - o.created_at)) / 86400.0, 0))
      FROM public.commercial_opportunities o
     WHERE o.account_id = a.id
       AND o.deleted_at IS NULL
       AND o.status = 'pre_sale_closed' AND o.sub_status = 'won'
       AND o.decided_at IS NOT NULL
  ) AS avg_days_to_close

FROM public.commercial_accounts a
WHERE a.deleted_at IS NULL;

GRANT SELECT ON public.commercial_account_overview_v TO authenticated;
GRANT SELECT ON public.commercial_account_overview_v TO service_role;

-- ========== 083 ==========
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

-- ========== 084 ==========
-- Migration 084: NY sales-tax jurisdictions (Sales tax by ZIP).
--
-- Invoices already carry a manual `tax_pct`. This lets the platform AUTO-FILL
-- that rate from the project's ZIP: PPP configures the jurisdictions they work
-- in (name + combined rate + the ZIP prefixes that fall in it), and the invoice
-- form suggests the rate for the project's property ZIP.
--
-- NOTE (deliberate design): we do NOT hardcode NY tax rates in code — rates
-- change and are legally sensitive. PPP owns the data via the admin table +
-- seed rows are flagged in-app to VERIFY before relying on them.
--
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS public.commercial_tax_jurisdictions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  -- Combined state + local rate in THOUSANDTHS OF A PERCENT (8.625% = 8625) so
  -- common NY combined rates keep full precision as integers with no float drift.
  -- 0-20000 guard (0-20%).
  combined_rate_thou  INT NOT NULL CHECK (combined_rate_thou >= 0 AND combined_rate_thou <= 20000),
  -- ZIP prefixes that resolve to this jurisdiction (e.g. {'115','116','117'}).
  -- Longest-prefix match wins in the resolver so overlaps degrade sanely.
  zip_prefixes       TEXT[] NOT NULL DEFAULT '{}',
  -- Operator has confirmed this rate is current (seeded rows start false).
  verified           BOOLEAN NOT NULL DEFAULT FALSE,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID
);

CREATE INDEX IF NOT EXISTS idx_tax_jur_active ON public.commercial_tax_jurisdictions(active);

ALTER TABLE public.commercial_tax_jurisdictions ENABLE ROW LEVEL SECURITY;
DO $rls$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'commercial_tax_jurisdictions' AND policyname = 'tax_jur_service_role') THEN
    CREATE POLICY tax_jur_service_role ON public.commercial_tax_jurisdictions
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END
$rls$;

-- Seed PPP's likely NY service jurisdictions as a STARTING POINT — verified=FALSE
-- so the app flags them "confirm the current rate" and Katie/Karan adjust. These
-- ZIP prefixes are the common ones; the operator can refine per the admin page.
INSERT INTO public.commercial_tax_jurisdictions (name, combined_rate_thou, zip_prefixes, verified, notes)
SELECT * FROM (VALUES
  ('New York City (all boroughs)', 8875, ARRAY['100','101','102','103','104','111','112','113','114'], FALSE, 'NYC combined rate. Verify current rate + confirm the ZIP set for the boroughs you work.'),
  ('Nassau County', 8625, ARRAY['110','115','116','1180','1181'], FALSE, 'Long Island — Nassau. Verify rate + ZIP prefixes (11001-11599 range).'),
  ('Suffolk County', 8625, ARRAY['117','118','119'], FALSE, 'Long Island — Suffolk. Verify rate + ZIP prefixes.')
) AS v(name, combined_rate_thou, zip_prefixes, verified, notes)
WHERE NOT EXISTS (SELECT 1 FROM public.commercial_tax_jurisdictions);
