-- 107 — Work Order: crew email + schedule window (RUX-4)
--
-- Adds the fields needed to (a) email the crew the Work Order PDF on "send to
-- crew" and (b) give the crew a real schedule window, not just a start date.
-- Clock-in/out lands later with the Field Ops module (Karan 2026-08 decision:
-- schedule fields now, time tracking later).
--
-- All nullable + additive — no backfill, safe to run on a live table.

ALTER TABLE public.commercial_work_orders
  -- Foreman / crew email the sent PDF is delivered to (optional — a WO can still
  -- be printed/handed off without emailing).
  ADD COLUMN IF NOT EXISTS crew_email          TEXT,
  -- Target finish date so the crew sees a window, not just a start.
  ADD COLUMN IF NOT EXISTS scheduled_end_date  DATE,
  -- Stamped when the PDF was last emailed to the crew (distinct from sent_at,
  -- which marks the status flip — a WO can be "sent" with no email if crew_email
  -- was blank).
  ADD COLUMN IF NOT EXISTS crew_emailed_at     TIMESTAMPTZ;

COMMENT ON COLUMN public.commercial_work_orders.crew_email IS
  'Foreman/crew email the Work Order PDF is sent to on "send to crew" (optional).';
COMMENT ON COLUMN public.commercial_work_orders.scheduled_end_date IS
  'Target finish date — pairs with scheduled_start_date for the crew schedule window.';
COMMENT ON COLUMN public.commercial_work_orders.crew_emailed_at IS
  'When the PDF was last emailed to the crew (null = never emailed).';
