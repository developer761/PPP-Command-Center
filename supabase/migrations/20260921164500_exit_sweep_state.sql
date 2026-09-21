-- When the exit sweep last ran.
--
-- sweepExitsWith has existed since enrolment was built and was never called by
-- anything, so no conversation has ever ended because a customer booked. The
-- Automations screen has been rendering the seeded exit rules under "And it
-- stops when…" the whole time. lib/messaging/exit-sweep.ts is the half that was
-- missing; this is the watermark that keeps it off Salesforce's API every
-- single minute.
--
-- Separate from last_polled_at on purpose. The poll looks for NEW leads once a
-- minute; the sweep asks about EXISTING ones every five, because a campaign
-- step is hours or days away and there is nothing to win by asking sooner.
--
-- Defaulted to the epoch rather than NOW() so the first sweep after this lands
-- runs immediately instead of waiting out an interval.
ALTER TABLE public.sf_poll_state
  ADD COLUMN IF NOT EXISTS last_swept_at TIMESTAMPTZ NOT NULL
  DEFAULT TIMESTAMPTZ '1970-01-01 00:00:00+00';

COMMENT ON COLUMN public.sf_poll_state.last_swept_at IS
  'Watermark for the exit sweep (lib/messaging/exit-sweep.ts), which ends conversations whose Salesforce exit rules now match — booked, qualified or opted out. Throttled to SWEEP_INTERVAL_MS.';
