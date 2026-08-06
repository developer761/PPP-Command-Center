-- Migration 117: recreate commercial_account_overview_v excluding ARCHIVED opps.
--
-- The v4 view (082) filters opp subqueries on deleted_at IS NULL but NOT
-- archived_at IS NULL. The platform pipeline (listCommercialOpportunities) and
-- the dashboard exclude archived opps, so the Account 360 tiles (Open bids, Bid
-- range, Won, Lost, avg-days-to-close, last activity) counted opps the platform
-- had dropped — the account level didn't roll up to the platform level. Add
-- AND archived_at IS NULL to every correlated subquery over
-- commercial_opportunities so account ⊂ platform holds (audit #6).
--
-- CREATE OR REPLACE VIEW keeps the exact column order/names from 082; only the
-- opp WHERE filters changed. Safe to re-run.

CREATE OR REPLACE VIEW public.commercial_account_overview_v AS
SELECT
  a.id AS account_id,

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

  GREATEST(
    a.updated_at,
    a.created_at,
    COALESCE((SELECT MAX(created_at)        FROM public.commercial_account_contacts    WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(last_contacted_at) FROM public.commercial_account_contacts    WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(uploaded_at)       FROM public.commercial_account_documents   WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(assigned_at)       FROM public.commercial_account_assignments WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(updated_at)        FROM public.commercial_opportunities      WHERE account_id = a.id AND deleted_at IS NULL AND archived_at IS NULL), a.created_at)
  ) AS last_activity_at,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND archived_at IS NULL
       AND status IN ('qualifying', 'estimating', 'proposal')
  ), 0) AS open_opps_count,

  (
    SELECT SUM(bid_value_low_cents)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND archived_at IS NULL
       AND status IN ('qualifying', 'estimating', 'proposal')
       AND bid_value_low_cents IS NOT NULL
  ) AS total_active_bid_low_cents,

  (
    SELECT SUM(bid_value_high_cents)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND archived_at IS NULL
       AND status IN ('qualifying', 'estimating', 'proposal')
       AND bid_value_high_cents IS NOT NULL
  ) AS total_active_bid_high_cents,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND archived_at IS NULL
       AND ((status = 'pre_sale_closed' AND sub_status = 'won') OR status IN ('pre_construction', 'in_progress', 'billing', 'post_sale_closed'))
  ), 0) AS won_opps_count,

  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND archived_at IS NULL
       AND status = 'pre_sale_closed' AND sub_status = 'lost'
  ), 0) AS lost_opps_count,

  (
    SELECT MAX(updated_at)
      FROM public.commercial_opportunities
     WHERE account_id = a.id
       AND deleted_at IS NULL
       AND archived_at IS NULL
  ) AS last_opp_activity_at,

  (
    SELECT AVG(GREATEST(EXTRACT(EPOCH FROM (o.decided_at - o.created_at)) / 86400.0, 0))
      FROM public.commercial_opportunities o
     WHERE o.account_id = a.id
       AND o.deleted_at IS NULL
       AND o.archived_at IS NULL
       AND o.status = 'pre_sale_closed' AND o.sub_status = 'won'
       AND o.decided_at IS NOT NULL
  ) AS avg_days_to_close

FROM public.commercial_accounts a
WHERE a.deleted_at IS NULL;

GRANT SELECT ON public.commercial_account_overview_v TO authenticated;
GRANT SELECT ON public.commercial_account_overview_v TO service_role;
