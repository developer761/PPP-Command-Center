-- Migration 024: Phase 1 Batch 4 — Account 360 overview view.
--
-- Postgres view that aggregates per-account counts so the Account detail
-- page can render a one-glance "is this account healthy?" strip without
-- N+1 queries from the app.
--
-- Designed to GROW: as Phase 2 (Opportunity) and Phase 8 (Billing) ship,
-- this view picks up new columns (opportunities_count, total_bid,
-- total_invoiced, total_paid, balance_owed). The Account 360 UI renders
-- whatever columns exist; missing-yet ones show as a "Coming with
-- Phase N" placeholder so the page never changes shape.
--
-- View is recomputed on read (no materialization). PPP's expected
-- commercial scale is 50-500 accounts; aggregate cost is sub-millisecond.
-- If we ever cross 5k accounts, swap to a materialized view + refresh
-- trigger.
--
-- Excludes soft-deleted accounts (deleted_at IS NOT NULL).
--
-- Safe to re-run.

CREATE OR REPLACE VIEW public.commercial_account_overview_v AS
SELECT
  a.id AS account_id,

  -- People we talk to at the customer side.
  COALESCE((
    SELECT COUNT(DISTINCT contact_id)
      FROM public.commercial_account_contacts
     WHERE account_id = a.id
  ), 0) AS contact_count,

  -- PPP staff currently on the account (removed_at IS NULL).
  COALESCE((
    SELECT COUNT(*)
      FROM public.commercial_account_assignments
     WHERE account_id = a.id
       AND removed_at IS NULL
  ), 0) AS ppp_team_count,

  -- Documents on file. Active = not archived. Expired = active but past
  -- expires_at. Total = active + archived for the History view.
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

  -- "When did anything happen on this account?" Max across the four
  -- child tables + the account's own timestamps. COALESCE on each so
  -- GREATEST doesn't return NULL when a sub-table is empty.
  GREATEST(
    a.updated_at,
    a.created_at,
    COALESCE((SELECT MAX(created_at)  FROM public.commercial_account_contacts    WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(uploaded_at) FROM public.commercial_account_documents   WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(assigned_at) FROM public.commercial_account_assignments WHERE account_id = a.id), a.created_at)
  ) AS last_activity_at

FROM public.commercial_accounts a
WHERE a.deleted_at IS NULL;

-- Helpful for grant-by-default in some Supabase setups. Idempotent.
GRANT SELECT ON public.commercial_account_overview_v TO authenticated;
GRANT SELECT ON public.commercial_account_overview_v TO service_role;
