-- Sold jobs and approved change orders waiting to reach Salesforce.
--
-- Katie, 2026-10-13: "whenever we write in the commercial platform it should
-- immediately write back into their salesforce." Karan, 2026-10-15: "as soon as
-- a sold job is done."
--
-- WHY A QUEUE AND NOT A WRITE INSIDE THE CLICK
--
-- A Salesforce write takes a second or two, plus a read-back to prove it
-- landed. Doing that while somebody waits for "mark as won" to return means a
-- slow or unreachable Salesforce hangs or fails THEIR action — a Tomco job
-- would fail to be marked sold because another company's org was down. So the
-- status change does one cheap local insert here, and a per-minute cron does
-- the talking.
--
-- WHY A QUEUE AND NOT A PER-MINUTE SCAN
--
-- Asking Salesforce "what do you have?" every minute is ~90 SOQL calls a time
-- against org limits, to discover nothing changed. This costs one indexed
-- local query that returns zero rows in the normal case.

CREATE TABLE IF NOT EXISTS public.commercial_tomco_writeback_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What changed. 'sale' is the deal itself reaching sold; 'change_order' is
  -- one approved after the sale, which moves the sale's value and so has to
  -- follow it — the four differences closed on 2026-10-14 were all of these.
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'change_order')),

  opportunity_id UUID NOT NULL
    REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,
  -- Set for kind='change_order'. Null for a sale.
  change_order_id UUID
    REFERENCES public.commercial_change_orders(id) ON DELETE CASCADE,

  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  queued_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Bounded retries. A permanently rejected write must stop asking rather than
  -- hammer Salesforce every minute forever; `last_error` and the Slack alert
  -- from writeSf are how somebody finds out.
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,

  -- Set when the write succeeded, or when the decision was that nothing was
  -- needed. Either way it leaves the pending set.
  done_at TIMESTAMPTZ,
  outcome TEXT,

  -- A deal the decision function HOLDS stays pending, with the reason here so a
  -- reader can see what it is waiting for. Holding does NOT count as an attempt
  -- — a deal waiting on a person must not run out of retries while it waits.
  --
  -- It is re-attempted on a back-off (`RETRY_AFTER_MS`, an hour) rather than
  -- every minute or never: some holds clear themselves ("the deal is not in
  -- Salesforce yet", for a change order approved before its sale has synced)
  -- and some need a person. When a person does answer one in the review
  -- screen, `releaseHold` clears this and `last_attempt_at` so the very next
  -- tick acts on it.
  held_reason TEXT
);

COMMENT ON TABLE public.commercial_tomco_writeback_queue IS
  'Sold jobs and approved change orders waiting to be written to Salesforce. Drained by /api/cron/tomco-writeback. 2026-10-15.';

-- The hot path is "what is still pending", every minute.
CREATE INDEX IF NOT EXISTS commercial_tomco_writeback_queue_pending_idx
  ON public.commercial_tomco_writeback_queue (queued_at)
  WHERE done_at IS NULL;

-- One pending entry per thing. The status hook re-fires on every status change
-- by design (the narrow "only on the transition" gate already lost a deal once
-- — see the comment above the work-order ensure in status.ts), so without this
-- a deal edited five times would queue five writes of the same sale.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_tomco_writeback_queue_one_pending_sale_idx
  ON public.commercial_tomco_writeback_queue (opportunity_id)
  WHERE done_at IS NULL AND kind = 'sale';
CREATE UNIQUE INDEX IF NOT EXISTS commercial_tomco_writeback_queue_one_pending_co_idx
  ON public.commercial_tomco_writeback_queue (change_order_id)
  WHERE done_at IS NULL AND kind = 'change_order';

ALTER TABLE public.commercial_tomco_writeback_queue ENABLE ROW LEVEL SECURITY;
