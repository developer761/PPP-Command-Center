-- 041_commercial_opp_submittals_and_finishes.sql
-- 2026-06-30: Phase 2.5 — Submittals + Finish Schedule on Commercial CC.
--
-- Real-world workflow (Tomco Painting → Alta Construction submittal PDF):
--   1. Painter assembles a Submittal Package: Letter of Transmittal cover +
--      product spec sheets + samples + color charts.
--   2. Sends to GC. Cover has structured fields: To/Date/Job#/Attention/RE,
--      checkboxes for what's included, an items table (copies/date/#/desc),
--      and a transmission type (For approval / For your use / As requested /
--      For review / For bids / Prints returned).
--   3. GC responds: Approved / Approved as noted / Returned for corrections,
--      plus optional "Resubmit N copies" / "Submit N copies for distribution".
--   4. If returned, painter creates a Resubmission — a separate row that
--      references the prior via `revises_submittal_id`.
--
-- Tables:
--   - commercial_opportunities.ppp_job_number (free-form, optional)
--   - commercial_opp_finishes (WD-1, P-1, EX-1 codes per opp)
--   - commercial_opp_submittals (one row per Letter of Transmittal)
--   - commercial_opp_submittal_items (rows in the items table on the cover)
--   - commercial_opp_submittal_status_log (audit trail for "days waiting on GC")
--   - commercial_opportunity_attachments.submittal_id (link a PDF to a specific submittal)
--
-- Idempotent (every CREATE uses IF NOT EXISTS; every ALTER uses
-- ADD COLUMN IF NOT EXISTS). Safe to re-paste into Supabase SQL Editor.
--
-- Pre-build audit findings baked in (see ~/Desktop/SUBMITTALS_PHASE_PLAN.md):
--   C1: UNIQUE(opp_id, submittal_number) — lib retries on 23505
--   C2: revises_submittal_id FK — resubmissions are separate rows
--   C3: UNIQUE(opp_id, lower(code)) — case-insensitive finish-code uniqueness
--   C4: attachment.submittal_id ON DELETE SET NULL — void preserves PDFs
--   C5: no deleted_at on children — hide via parent opp.deleted_at
--   C7: status DAG + status_log table for "days waiting" reports
--   S1: CHECK (response_received_at >= sent_at when both set)
--   S4: position INT sparse (default 1000) for drag-reorder without rewrites

-- ─────────────────────────────────────────────────────────────────────
-- 1. ppp_job_number on opportunities
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS ppp_job_number TEXT;

COMMENT ON COLUMN public.commercial_opportunities.ppp_job_number IS
  'PPP-internal job tracking number (e.g. "22377 - VCA #929"). Free-form, optional, may recur across closed opps.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. commercial_opp_finishes — Finish Schedule per opp
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commercial_opp_finishes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,

  code TEXT NOT NULL,
    -- "WD-1", "P-1", "EX-1" — architect-spec codes that appear on plans
  location_description TEXT,
    -- "Stair handrails, lobby trim"
  product_name TEXT,
    -- "Emerald Urethane Trim Enamel"
  manufacturer TEXT,
    -- "Sherwin-Williams"
  color TEXT,
    -- "Penofin Verde Olive"
  sheen TEXT,
    -- "Satin", "Semi-gloss", "Eggshell"
  finish_type TEXT,
    -- "wood_stain", "paint", "primer", "sealer", "specialty"
  notes TEXT,

  position INTEGER NOT NULL DEFAULT 1000,
    -- sparse gap-1000 (audit S4) so drag-reorder doesn't rewrite every row

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Case-insensitive uniqueness — Alex typing "wd-1" + "WD-1" should collide.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_opp_finishes_opp_code_uniq
  ON public.commercial_opp_finishes (opportunity_id, lower(code));

CREATE INDEX IF NOT EXISTS commercial_opp_finishes_opp_idx
  ON public.commercial_opp_finishes (opportunity_id, position);

DROP TRIGGER IF EXISTS trg_commercial_opp_finishes_updated_at ON public.commercial_opp_finishes;
CREATE TRIGGER trg_commercial_opp_finishes_updated_at
  BEFORE UPDATE ON public.commercial_opp_finishes
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- 3. commercial_opp_submittals — one row per Letter of Transmittal
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commercial_opp_submittals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,

  -- Per-opp sequence. Lib computes via SELECT MAX(+1) and retries on 23505
  -- if a concurrent insert races. UNIQUE constraint enforces correctness.
  submittal_number INTEGER NOT NULL,

  -- Resubmissions: this row references the prior submittal it revises.
  -- Industry norm (CSI MasterFormat): each resubmittal is its own log entry.
  -- SET NULL on parent delete so audit trail survives.
  revises_submittal_id UUID REFERENCES public.commercial_opp_submittals(id) ON DELETE SET NULL,
  revision_number INTEGER NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',                  -- being assembled
      'submitted',              -- sent to GC, awaiting acknowledgement
      'under_review',           -- GC has opened/acknowledged
      'approved',               -- approved as submitted
      'approved_as_noted',      -- approved with comments
      'revise_and_resubmit',    -- needs changes; create a revision row
      'rejected',               -- declined outright
      'closed',                 -- terminal — no further action
      'voided'                  -- sent in error; preserved for audit
    )),

  -- Cover-page metadata (snapshotted at send-time so account-side renames
  -- don't rewrite history)
  to_company TEXT,
  to_attention TEXT,
  to_address_lines TEXT[],
  re_subject TEXT DEFAULT 'Submittals',

  -- "WE ARE SENDING YOU" checkboxes from the cover. Array enforces enum
  -- membership via <@ ANY-of constraint so future kinds can be added by
  -- ALTER without a column-add.
  included_kinds TEXT[] NOT NULL DEFAULT '{}'
    CHECK (included_kinds <@ ARRAY[
      'shop_drawings','prints','plans','samples',
      'specifications','submittals','copy_of_letter',
      'change_order','contracts'
    ]::TEXT[]),

  -- "THESE ARE TRANSMITTED" radio from the cover. NULL = not yet picked.
  transmitted_as TEXT
    CHECK (transmitted_as IS NULL OR transmitted_as IN (
      'for_approval','for_your_use','as_requested',
      'for_review','for_bids','prints_returned'
    )),

  -- GC response side. NULL = pending.
  response TEXT
    CHECK (response IS NULL OR response IN (
      'approved','approved_as_noted','returned_for_corrections',
      'resubmit','submit_for_distribution','return_corrected_prints'
    )),
  response_copies INTEGER,  -- "Resubmit N copies", "Submit N copies", etc.

  sent_at TIMESTAMPTZ,
  response_received_at TIMESTAMPTZ,
  -- audit S1: can't receive a response before sending
  CONSTRAINT submittal_response_after_sent_chk
    CHECK (response_received_at IS NULL
        OR sent_at IS NULL
        OR response_received_at >= sent_at),

  remarks TEXT,

  -- Voided pathway — sent in error
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT submittal_void_paired_chk CHECK (
    (voided_at IS NULL AND voided_by_user_id IS NULL AND void_reason IS NULL)
    OR
    (voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL AND void_reason IS NOT NULL)
  ),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS commercial_opp_submittals_opp_num_uniq
  ON public.commercial_opp_submittals (opportunity_id, submittal_number);

CREATE INDEX IF NOT EXISTS commercial_opp_submittals_opp_idx
  ON public.commercial_opp_submittals (opportunity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS commercial_opp_submittals_revises_idx
  ON public.commercial_opp_submittals (revises_submittal_id)
  WHERE revises_submittal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commercial_opp_submittals_status_idx
  ON public.commercial_opp_submittals (opportunity_id, status);

DROP TRIGGER IF EXISTS trg_commercial_opp_submittals_updated_at ON public.commercial_opp_submittals;
CREATE TRIGGER trg_commercial_opp_submittals_updated_at
  BEFORE UPDATE ON public.commercial_opp_submittals
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- 4. commercial_opp_submittal_items — rows in the cover's items table
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commercial_opp_submittal_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submittal_id UUID NOT NULL REFERENCES public.commercial_opp_submittals(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 1000,
  copies INTEGER NOT NULL DEFAULT 1 CHECK (copies > 0),
  item_date DATE,
  item_number TEXT,                 -- free-form architect ref #
  description TEXT NOT NULL,
  -- Soft reference (audit C6) to commercial_opp_finishes.code — TEXT not FK
  -- because items get logged off architect drawings before the finish is
  -- entered. Lib warns on save if code isn't in finish schedule.
  finish_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commercial_opp_submittal_items_submittal_idx
  ON public.commercial_opp_submittal_items (submittal_id, position);

DROP TRIGGER IF EXISTS trg_commercial_opp_submittal_items_updated_at ON public.commercial_opp_submittal_items;
CREATE TRIGGER trg_commercial_opp_submittal_items_updated_at
  BEFORE UPDATE ON public.commercial_opp_submittal_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- 5. commercial_opp_submittal_status_log — per-status-change audit trail
-- ─────────────────────────────────────────────────────────────────────
-- Mirror of migration 029 commercial_opportunity_status_log. Separate from
-- the generic commercial_audit_log so reports like "days waiting on GC" can
-- query a single small table without parsing JSON diffs.

CREATE TABLE IF NOT EXISTS public.commercial_opp_submittal_status_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submittal_id UUID NOT NULL REFERENCES public.commercial_opp_submittals(id) ON DELETE CASCADE,
  from_status TEXT,                 -- NULL on initial draft creation
  to_status TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS commercial_opp_submittal_status_log_submittal_idx
  ON public.commercial_opp_submittal_status_log (submittal_id, changed_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 6. attach submittal_id to existing attachments table
-- ─────────────────────────────────────────────────────────────────────
-- ON DELETE SET NULL (audit C4): voiding a submittal preserves its PDFs for
-- audit. Attachment falls back to "unattached" on the Plans & Specs tab.

ALTER TABLE public.commercial_opportunity_attachments
  ADD COLUMN IF NOT EXISTS submittal_id UUID
    REFERENCES public.commercial_opp_submittals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS commercial_opportunity_attachments_submittal_idx
  ON public.commercial_opportunity_attachments (submittal_id)
  WHERE submittal_id IS NOT NULL AND archived = FALSE;

COMMENT ON COLUMN public.commercial_opportunity_attachments.submittal_id IS
  'Optional FK linking an attachment to a specific submittal. NULL = generic Plans/Specs attachment. ON DELETE SET NULL so voiding a submittal preserves the PDF.';

-- ─────────────────────────────────────────────────────────────────────
-- Migration 041 complete. Verification queries below (run separately).
-- ─────────────────────────────────────────────────────────────────────

-- Confirm all new tables exist + counts:
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'public'
--    AND table_name IN ('commercial_opp_finishes','commercial_opp_submittals',
--                       'commercial_opp_submittal_items',
--                       'commercial_opp_submittal_status_log');

-- Confirm constraints landed:
-- SELECT conname, contype FROM pg_constraint
--  WHERE conrelid IN ('public.commercial_opp_finishes'::regclass,
--                     'public.commercial_opp_submittals'::regclass,
--                     'public.commercial_opp_submittal_items'::regclass)
--  ORDER BY conname;

-- Confirm indexes landed:
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname = 'public'
--    AND tablename IN ('commercial_opp_finishes','commercial_opp_submittals',
--                      'commercial_opp_submittal_items',
--                      'commercial_opp_submittal_status_log',
--                      'commercial_opportunity_attachments')
--    AND indexname LIKE '%submittal%' OR indexname LIKE '%finish%';
