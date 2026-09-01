-- Migration 183: atomic claim for the due-work queue.
--
-- PostgREST cannot express FOR UPDATE SKIP LOCKED, and without it two overlapping
-- cron runs read the same pending row and both send it. The customer gets the
-- message twice. Vercel can and does overlap invocations, so this is not
-- theoretical.
--
-- SKIP LOCKED rather than plain FOR UPDATE: a second worker should move past a
-- row another worker holds and pick up different work, not queue behind it. A
-- minute-ly tick that blocks is a minute-ly tick that stops.
--
-- The claim increments attempts as it takes the row. Counting on completion
-- instead would let a row that crashes mid-send be retried forever, because a
-- crash is exactly the path that never reaches the increment.
--
-- Safe to re-run.

CREATE OR REPLACE FUNCTION public.sms_claim_due_actions(p_limit INTEGER DEFAULT 50)
RETURNS SETOF public.sms_scheduled_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.sms_scheduled_actions a
     SET state      = 'claimed',
         claimed_at = NOW(),
         attempts   = a.attempts + 1,
         updated_at = NOW()
   WHERE a.id IN (
           SELECT id
             FROM public.sms_scheduled_actions
            WHERE state = 'pending'
              AND run_at <= NOW()
            ORDER BY run_at
            LIMIT p_limit
            FOR UPDATE SKIP LOCKED
         )
  RETURNING a.*;
END;
$$;

-- A worker that dies between claiming and finishing leaves its rows 'claimed'
-- forever. Nothing would ever send them again and nothing would report it —
-- the queue would just quietly get shorter. Anything held longer than the
-- timeout goes back to pending.
--
-- 10 minutes is comfortably longer than a send plus a Salesforce round-trip on
-- Vercel Pro's 300s ceiling, so a slow-but-alive worker is never robbed of its
-- own row mid-flight.
CREATE OR REPLACE FUNCTION public.sms_reclaim_stale_actions(p_older_than INTERVAL DEFAULT '10 minutes')
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE public.sms_scheduled_actions
     SET state = 'pending', claimed_at = NULL, updated_at = NOW()
   WHERE state = 'claimed'
     AND claimed_at < NOW() - p_older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.sms_claim_due_actions(INTEGER) IS
  'Atomically claims due actions with FOR UPDATE SKIP LOCKED. Without it, overlapping cron runs read the same row and the customer is texted twice. Attempts increments on CLAIM, not completion, so a row that crashes mid-send cannot retry forever.';
COMMENT ON FUNCTION public.sms_reclaim_stale_actions(INTERVAL) IS
  'Returns rows abandoned by a dead worker to pending. Without it the queue silently gets shorter and nothing reports why.';
