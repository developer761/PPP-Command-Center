-- Who decided a sold Tomco deal was new to Salesforce, and when.
--
-- The write-back runs unattended for anything that cannot have a Salesforce
-- twin, and HOLDS anything that might. A held deal has exactly two resolutions:
--
--   "this is the same job"  → a row in commercial_import_map, which is already
--                             the link between the two systems and is what the
--                             nightly importer reads. Nothing new needed.
--   "no, it's new"          → nowhere to record it, until this table.
--
-- Without the second, a deal somebody has already looked at and cleared comes
-- back in the queue on every run, and a queue that re-asks answered questions
-- stops being read — which is how the one genuinely risky item gets skimmed
-- past.
--
-- Also an audit trail: "who decided this was a new sale" is a real question
-- once a duplicate turns up in Katie's total, and the answer should not be
-- "nobody knows".

CREATE TABLE IF NOT EXISTS public.commercial_tomco_writeback_decisions (
  opportunity_id UUID PRIMARY KEY
    REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,

  -- 'new'      — checked the open Salesforce estimates, none is this job.
  -- 'paired'   — recorded for the audit trail; the LINK itself lives in
  --              commercial_import_map, so this row is a note, not the source
  --              of truth. Kept so the queue can show who paired what.
  decision TEXT NOT NULL CHECK (decision IN ('new', 'paired')),

  -- Set only for 'paired'. The Salesforce opportunity the person chose.
  sf_opportunity_id TEXT,

  -- What they were choosing between, frozen at the moment they chose. A
  -- decision is only reviewable if you can see what the alternatives looked
  -- like — the candidate list changes as estimates close.
  candidates_seen JSONB NOT NULL DEFAULT '[]'::jsonb,

  decided_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Reversible. Somebody who clears a deal as new and then finds the twin
  -- needs to undo it without a DBA, so the queue offers it and this records
  -- that it happened rather than deleting the evidence.
  undone_at TIMESTAMPTZ,
  undone_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.commercial_tomco_writeback_decisions IS
  'Human decisions on Tomco write-back holds. "paired" is a note; the link itself is in commercial_import_map. 2026-10-14.';

-- The queue asks "what is still unresolved", so the live rows are the hot path.
CREATE INDEX IF NOT EXISTS commercial_tomco_writeback_decisions_live_idx
  ON public.commercial_tomco_writeback_decisions (decision)
  WHERE undone_at IS NULL;

ALTER TABLE public.commercial_tomco_writeback_decisions ENABLE ROW LEVEL SECURITY;
