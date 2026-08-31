-- Migration 176: sms_opt_outs — the suppression list.
--
-- The single most legally consequential table in the messaging system. Every
-- outbound message is checked against it, without exception, before it reaches
-- a transport. Texting a number that opted out carries statutory damages per
-- message under the TCPA.
--
-- Populated from three sources:
--   1. The export out of Hatch, before the first message is ever sent. A
--      customer who told Hatch to stop has told PPP to stop; the vendor
--      changing underneath them is not their problem.
--   2. Inbound STOP / UNSUBSCRIBE / CANCEL / END / QUIT / OPTOUT keywords,
--      classified by lib/messaging/compliance.ts.
--   3. Anyone the office suppresses by hand.
--
-- Keyed by phone number, NOT by customer, conversation or workspace. An opt-out
-- is a property of the human holding the handset. Someone who reached PPP
-- through both Meta and Google LSA is one person, and saying STOP once must
-- silence every workspace and every agent at once.
--
-- Numbers are stored E.164 (+15163448418) so "(516) 344-8418", "516-344-8418"
-- and "5163448418" cannot become three rows, one of which is not checked.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_opt_outs (
  phone_e164     TEXT PRIMARY KEY CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  opted_out_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Where the opt-out came from. 'hatch_import' rows predate our first send
  -- and must survive any re-import.
  source         TEXT NOT NULL CHECK (source IN ('inbound_keyword', 'hatch_import', 'manual', 'carrier')),
  -- The exact inbound text, when a keyword caused it. Kept verbatim: if an
  -- opt-out is ever disputed, "they replied 'Stop.'" is the evidence.
  inbound_body   TEXT,
  -- Which workspace saw it. Informational only — suppression is global.
  workspace_id   UUID,
  -- Re-subscription. A row is NEVER deleted: START clears this by setting
  -- opted_in_at, so the history of both decisions survives. Deleting would
  -- make a re-opt-out indistinguishable from someone who never opted out.
  opted_in_at    TIMESTAMPTZ,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The hot path: "is this number suppressed right now", run before EVERY send.
-- Partial index because a re-subscribed row is not a suppression and should
-- not sit in the index the send path scans.
CREATE INDEX IF NOT EXISTS sms_opt_outs_active_idx
  ON public.sms_opt_outs (phone_e164)
  WHERE opted_in_at IS NULL;

ALTER TABLE public.sms_opt_outs ENABLE ROW LEVEL SECURITY;

-- Server-side only, via the admin client behind lib/messaging/gate.ts. No
-- anon or authenticated policy on purpose: the browser has no reason to read
-- the suppression list and every reason not to be able to write it. Matches
-- the posture of supplier_orders and wo_followup_dates.
DROP POLICY IF EXISTS sms_opt_outs_no_client ON public.sms_opt_outs;

COMMENT ON TABLE public.sms_opt_outs IS
  'TCPA suppression list. Checked before every outbound message, no exceptions. Keyed by E.164 phone number because an opt-out belongs to the person, not to a conversation or workspace — one STOP silences every agent. Rows are never deleted; re-subscription sets opted_in_at. Migration 176.';
COMMENT ON COLUMN public.sms_opt_outs.opted_in_at IS
  'Set when the number replies START/UNSTOP. NULL means actively suppressed — the partial index the send path uses only covers these.';
