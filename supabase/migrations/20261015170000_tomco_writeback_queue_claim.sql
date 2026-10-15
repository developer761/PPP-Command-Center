-- Make the write-back queue safe for two ticks at once, and verifiable.
--
-- 🔴 WHY THIS IS NOT OPTIONAL
--
-- `claimPending` was a plain SELECT on `done_at IS NULL`. Nothing marked a row
-- as taken until that row's processing FINISHED — which includes a six-second
-- wait for Salesforce's rollups plus three to six SOQL round trips, so ten to
-- twenty seconds per entry and up to 200s for a full batch of ten. The cron
-- fires every sixty seconds. Two ticks therefore overlap routinely, and the
-- second one re-reads entries the first is still working on.
--
-- For a change order that means both ticks find no link, both find nothing at
-- the matching amount, and both run `ChangeOrder__c.create` — two approved
-- change orders for one piece of work, so `TotalChangeOrder__c` doubles and the
-- canonical figure Katie's reports run on is overstated. Salesforce has no
-- uniqueness on that object to refuse it. For a sale it means two Quotes on one
-- opportunity, after which every later attempt fails for good on "2 quotes —
-- a person has to say which is the sale", leaving the opportunity Closed Won
-- with no money on it.
--
-- So: an atomic claim. A tick takes a row with a conditional UPDATE and only
-- works on it if that UPDATE returned the row.

ALTER TABLE public.commercial_tomco_writeback_queue
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.commercial_tomco_writeback_queue.claimed_at IS
  'Set by the tick that is working on this entry, atomically. Cleared when it finishes. An old value means a tick died mid-entry; claimPending reclaims it after CLAIM_STALE_MS.';

-- The claim query: pending, not claimed (or claimed long enough ago to be
-- abandoned), oldest first.
CREATE INDEX IF NOT EXISTS commercial_tomco_writeback_queue_claim_idx
  ON public.commercial_tomco_writeback_queue (claimed_at, queued_at)
  WHERE done_at IS NULL;

-- A change_order entry with no change order is a bug in whatever queued it, and
-- the partial unique index could not refuse it: a unique index on a NULLable
-- column does not constrain NULLs, so any number of them could pile up, each
-- burning a slot in a tick before being marked done.
ALTER TABLE public.commercial_tomco_writeback_queue
  DROP CONSTRAINT IF EXISTS commercial_tomco_writeback_queue_co_id_matches_kind;
ALTER TABLE public.commercial_tomco_writeback_queue
  ADD CONSTRAINT commercial_tomco_writeback_queue_co_id_matches_kind
  CHECK ((kind = 'change_order') = (change_order_id IS NOT NULL));

/*
 * A WRITE THIS QUEUE BELIEVED AND SHOULD NOT HAVE.
 *
 * The tick reads every write back and verifies it. When a check failed the
 * entry was marked FAILED, which was right — but an hour later the retry found
 * Salesforce already in its new state, returned "nothing to do", and called
 * `markDone`, which also cleared `last_error`. So an entry whose verification
 * had genuinely failed ended up green, with the evidence erased. That is how a
 * sale sitting at $0 in Katie's reports read as a clean sync.
 *
 * `verify_failed_at` survives that. It is set when a read-back disagrees and
 * cleared only by a read-back that passes, so "written but never verified" is a
 * state the review screen can show and a person can act on.
 */
ALTER TABLE public.commercial_tomco_writeback_queue
  ADD COLUMN IF NOT EXISTS verify_failed_at TIMESTAMPTZ;
ALTER TABLE public.commercial_tomco_writeback_queue
  ADD COLUMN IF NOT EXISTS verify_failed_reason TEXT;

COMMENT ON COLUMN public.commercial_tomco_writeback_queue.verify_failed_at IS
  'A read-back disagreed with what we wrote. Cleared only by a read-back that passes — never by marking the entry done.';
