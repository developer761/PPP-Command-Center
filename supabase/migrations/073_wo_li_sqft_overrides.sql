-- 073_wo_li_sqft_overrides.sql
-- Per-room square-footage overrides for Materials Ordering (Kate #17).
--
-- Background: ~77% of PPP's open paint rooms have no Sq_Footage__c in
-- Salesforce, so JobDetail lets staff type the number in. The old path tried
-- to WRITE Sq_Footage__c back to Salesforce — but that field is a FORMULA
-- field, so every write was rejected (502) and the value never persisted.
--
-- Fix: store the manually-entered value HERE (Command Center owns it) and
-- hydrate it on page load. Salesforce stays the source of truth for the
-- rooms/colors; this table only holds the human-entered measurement overlay
-- the gallon estimator needs. A local value always wins over the SF value.

CREATE TABLE IF NOT EXISTS public.wo_li_sqft_overrides (
  woli_id       TEXT PRIMARY KEY,                 -- WorkOrderLineItem Id (15/18)
  work_order_id TEXT,                             -- parent WO Id (nullable; for grouping)
  sqft          INTEGER NOT NULL CHECK (sqft >= 0 AND sqft <= 100000),
  updated_by    TEXT,                             -- who set it (email / SF name)
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wo_li_sqft_overrides_wo_idx
  ON public.wo_li_sqft_overrides (work_order_id);

-- Service-role only (the API route reads/writes with the service key). No
-- anon/authenticated policies → RLS denies all direct client access.
ALTER TABLE public.wo_li_sqft_overrides ENABLE ROW LEVEL SECURITY;
