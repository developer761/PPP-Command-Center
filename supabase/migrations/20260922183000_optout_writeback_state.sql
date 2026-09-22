-- Whether an opt-out has made it back into Salesforce.
--
-- Today it does not. Hatch fires a webhook, Apex matches on the last ten
-- digits of a phone or an exact email, and on a miss an error email goes to
-- info@ for somebody to transcribe by hand. Kate measured that path:
--
--    213  notifications Salesforce could not match
--     98  had no Salesforce record at all
--     55  matched a record STILL not marked opted out
--     50  of those with the record sitting right there when it fired
--
-- The failure is the human step. lib/messaging/optout-writeback.ts was written
-- to remove it and has never had a caller; this is the state it needs.
--
-- WHY A COLUMN AND NOT A QUEUE. An opt-out that has not reached Salesforce is
-- not a job that failed, it is a fact that is only half recorded. Keeping the
-- state on the opt-out row means "who is suppressed" and "who does Salesforce
-- know about" are one query apart and cannot drift.
--
-- 'pending_no_record' is the 98-of-213 case: somebody opted out before any
-- Salesforce record existed for them. That is NOT an error — our suppression
-- list already holds, and the write is enrichment. It stays pending so a
-- record appearing later can still be marked.

ALTER TABLE public.sms_opt_outs
  ADD COLUMN IF NOT EXISTS sf_writeback_status TEXT
    CHECK (sf_writeback_status IN ('written','pending_no_record','failed')),
  ADD COLUMN IF NOT EXISTS sf_writeback_at     TIMESTAMPTZ,
  -- Which records were updated, or why none were. Read by a person, not code.
  ADD COLUMN IF NOT EXISTS sf_writeback_detail TEXT,
  -- Bounded retries. A row failing on permissions must not be retried on every
  -- tick forever, and the count is the signal that something needs a person.
  ADD COLUMN IF NOT EXISTS sf_writeback_tries  SMALLINT NOT NULL DEFAULT 0;

-- The sweep's own query: never written, or written to nothing and worth
-- another look. Partial so it stays small as the table grows — the rows that
-- succeeded are the ones nobody needs to find again.
CREATE INDEX IF NOT EXISTS sms_opt_outs_writeback_idx
  ON public.sms_opt_outs (opted_out_at)
  WHERE sf_writeback_status IS DISTINCT FROM 'written';

COMMENT ON COLUMN public.sms_opt_outs.sf_writeback_status IS
  'Whether this opt-out reached Salesforce. pending_no_record means no Lead or Contact matched, which is expected and not an error — the suppression already holds here. See lib/messaging/optout-writeback.ts.';
