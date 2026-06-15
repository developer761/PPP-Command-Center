-- Migration 027: Phase 1 Batch B — feed contact touchpoints into the
-- Account 360 overview view.
--
-- Migration 026 added `last_contacted_at` on commercial_account_contacts
-- so PPP staff can record "I just emailed Jane." For that timestamp to
-- bubble into the "last activity" badge on the Accounts list (+ drive
-- the activity sort), the overview view has to pick it up.
--
-- IMPORTANT: column order + column names must EXACTLY match migration
-- 024's view, otherwise Postgres rejects with:
--   "cannot change name of view column X to Y"
-- CREATE OR REPLACE VIEW can only ADD trailing columns or change types;
-- it cannot rename or reorder existing columns. So we keep every
-- column 1:1 with 024 and only patch the GREATEST expression inside
-- `last_activity_at`.
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

  -- "When did anything happen on this account?" Max across child tables
  -- + the account's own timestamps. v2: also pick up the new
  -- last_contacted_at (added in migration 026) so that clicking
  -- "I just touched base" moves the account in the activity sort.
  GREATEST(
    a.updated_at,
    a.created_at,
    COALESCE((SELECT MAX(created_at)        FROM public.commercial_account_contacts    WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(last_contacted_at) FROM public.commercial_account_contacts    WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(uploaded_at)       FROM public.commercial_account_documents   WHERE account_id = a.id), a.created_at),
    COALESCE((SELECT MAX(assigned_at)       FROM public.commercial_account_assignments WHERE account_id = a.id), a.created_at)
  ) AS last_activity_at

FROM public.commercial_accounts a
WHERE a.deleted_at IS NULL;

GRANT SELECT ON public.commercial_account_overview_v TO authenticated;
GRANT SELECT ON public.commercial_account_overview_v TO service_role;
