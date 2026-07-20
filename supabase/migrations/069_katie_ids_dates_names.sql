-- Migration 069 · Katie's 2026-07-20 asks + Phase G audit fixes
--
-- Bundle:
--   (A) commercial_opportunities.rfp_received_at   — Katie ask #3, "RFP Received" date
--   (B) commercial_opportunities.title_override    — Katie ask #2, editable Opportunity name
--   (C) commercial_proposals.proposal_seq          — Katie ask #1, "Proposal-####" ID
--   (D) commercial_proposals.proposal_number       — generated column PROP-####
--   (E) INDEX on (account_id, LOWER(client_name), LOWER(property_street))
--         — Phase G audit HIGH: migration 066 renamed the column but the
--         composite index from migration 046 still points at location_short.
--         Add the property_street twin so duplicates.ts query is O(log n)
--         again instead of a table scan.
--
-- All idempotent. Safe to re-run. Paste in Supabase SQL editor.

-- ─────────────────────────────────────────────────────────────────────
-- (A) RFP Received date on opportunities
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS rfp_received_at TIMESTAMPTZ;

COMMENT ON COLUMN public.commercial_opportunities.rfp_received_at IS
  'Date the RFP / bid request arrived from the GC. Used to compute
   time-to-proposal = (proposal.sent_at - rfp_received_at) and
   time-to-sale = (decided_at - proposal.sent_at). Nullable — legacy
   opps + opps logged without an RFP source leave this NULL.';

-- ─────────────────────────────────────────────────────────────────────
-- (B) Editable Opportunity Name override
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS title_override TEXT;

COMMENT ON COLUMN public.commercial_opportunities.title_override IS
  'When set, wins over derivedOppName''s computed
   {account}—{client_name}—{property_street} display. Users edit this
   via the "Custom deal name" field on the deal edit sheet. Leave NULL
   to use the auto-derived name.';

-- ─────────────────────────────────────────────────────────────────────
-- (C) + (D) Proposal-#### unique identifier
-- ─────────────────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS public.commercial_proposal_seq START 1;

ALTER TABLE public.commercial_proposals
  ADD COLUMN IF NOT EXISTS proposal_seq INTEGER;

-- Backfill existing proposals in created_at order so early rows get
-- low numbers. Guarded so re-runs skip already-numbered rows.
DO $$
DECLARE
  r RECORD;
  n INTEGER;
BEGIN
  FOR r IN
    SELECT id FROM public.commercial_proposals
    WHERE proposal_seq IS NULL
    ORDER BY created_at ASC, id ASC
  LOOP
    n := nextval('public.commercial_proposal_seq');
    UPDATE public.commercial_proposals SET proposal_seq = n WHERE id = r.id;
  END LOOP;
END $$;

-- Trigger — auto-assign proposal_seq on insert.
CREATE OR REPLACE FUNCTION public.commercial_proposal_assign_seq()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.proposal_seq IS NULL THEN
    NEW.proposal_seq := nextval('public.commercial_proposal_seq');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commercial_proposal_assign_seq_trg ON public.commercial_proposals;
CREATE TRIGGER commercial_proposal_assign_seq_trg
  BEFORE INSERT ON public.commercial_proposals
  FOR EACH ROW EXECUTE FUNCTION public.commercial_proposal_assign_seq();

-- Add unique constraint so a data-repair mistake can't create dupes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'commercial_proposals_seq_unique_idx'
  ) THEN
    CREATE UNIQUE INDEX commercial_proposals_seq_unique_idx
      ON public.commercial_proposals (proposal_seq)
      WHERE proposal_seq IS NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.commercial_proposals.proposal_seq IS
  'Global sequential ID. Rendered as PROP-#### (LPAD 4) in the UI.
   Auto-assigned via trigger on insert; nullable at the column level
   only so backfill can catch up. New rows always get one.';

-- ─────────────────────────────────────────────────────────────────────
-- (E) Composite index on property_street for duplicates.ts dedup query
-- ─────────────────────────────────────────────────────────────────────
-- Phase G audit HIGH finding: migration 046 built the index on
-- (account_id, LOWER(client_name), LOWER(location_short)). Migration
-- 066 backfilled the data into property_street + duplicates.ts filters
-- on property_street. Without a fresh index the dedup query does a
-- table scan on every "create deal" form submit. Drop the stale one
-- after migration 068 removes the column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'commercial_opportunities_dup_detect_property_idx'
  ) THEN
    CREATE INDEX commercial_opportunities_dup_detect_property_idx
      ON public.commercial_opportunities (
        account_id,
        LOWER(client_name),
        LOWER(property_street)
      )
      WHERE deleted_at IS NULL;
  END IF;
END $$;
