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
       AND status IN ('inquiry', 'site_visit_scheduled', 'site_visit_done',
                      'estimating', 'proposal_sent', 'negotiating', 'on_hold')
  ), 0) AS open_opps_count,

  -- NULL signal (no bids yet) vs 0 (bids exist but all priced at 0). We
  -- preserve the distinction by NOT wrapping the SUM in COALESCE(..., 0).
  (
    SELECT SUM(bid_value_low_cents)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND status IN ('inquiry', 'site_visit_scheduled', 'site_visit_done',
                      'estimating', 'proposal_sent', 'negotiating', 'on_hold')
       AND bid_value_low_cents IS NOT NULL
  ) AS total_active_bid_low_cents,

  (
    SELECT SUM(bid_value_high_cents)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND status IN ('inquiry', 'site_visit_scheduled', 'site_visit_done',
                      'estimating', 'proposal_sent', 'negotiating', 'on_hold')
       AND bid_value_high_cents IS NOT NULL
  ) AS total_active_bid_high_cents,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND status = 'won'
  ), 0) AS won_opps_count,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND status IN ('lost', 'no_bid')
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
       AND o.status = 'won'
       AND o.decided_at IS NOT NULL
  ) AS avg_days_to_close

FROM public.commercial_accounts a
WHERE a.deleted_at IS NULL;

GRANT SELECT ON public.commercial_account_overview_v TO authenticated;
GRANT SELECT ON public.commercial_account_overview_v TO service_role;
