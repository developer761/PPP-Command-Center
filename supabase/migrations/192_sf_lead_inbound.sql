-- Migration 192: lead intake, and why it accepts the same lead twice.
--
-- The headline improvement over Hatch. Hatch polls Salesforce every 15 MINUTES
-- and PPP has watched leads wait hours for a first reply. The target agreed on
-- 2026-09-02 is a message inside a minute.
--
-- THE DESIGN DECISION: push and poll both run. They are not alternatives.
--
--   PUSH  a Salesforce Flow fires a webhook on Lead create. Sub-second, and
--         the only way to actually hit the target. Needs PPP IT to add the
--         Flow, so it cannot be the only path.
--   POLL  a cron sweeps for leads created since the last run. Up to a minute
--         of latency, needs nothing from anyone, and catches everything a
--         webhook dropped — because webhooks do get dropped, and a lead that
--         silently never arrives is indistinguishable from a quiet day.
--
-- Running both is only safe if arriving twice is harmless, which is what
-- sf_record_id being UNIQUE buys. Whichever path gets there first creates the
-- row; the second is a no-op. That is the whole trick, and it means the poll
-- can be aggressive without any risk of double-messaging.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sf_lead_inbound (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The Salesforce record. UNIQUE, and the reason both paths can run at once.
  sf_record_id  TEXT NOT NULL,
  sf_object     TEXT NOT NULL DEFAULT 'Lead' CHECK (sf_object IN ('Lead','Opportunity')),

  -- How it reached us. Recorded so the poll's usefulness is measurable: if
  -- every row says 'push', the Flow is healthy; a run of 'poll' rows means
  -- webhooks are being dropped and nobody would otherwise know.
  arrived_via   TEXT NOT NULL CHECK (arrived_via IN ('push','poll','manual')),

  -- What Salesforce told us, verbatim. Kept whole because the field mapping is
  -- still unconfirmed with Katie, and a payload we stored raw can be re-read
  -- when it is. A payload we parsed and discarded cannot.
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Extracted for routing. Nullable because a lead with no phone is a real
  -- thing that has to be visible rather than rejected at the door.
  phone_e164    TEXT CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email         TEXT,
  full_name     TEXT,
  lead_source   TEXT,
  state_code    TEXT,
  locality      TEXT,

  -- Where it went, once routing has run.
  workspace_id     UUID REFERENCES public.sms_sub_accounts(id) ON DELETE SET NULL,
  conversation_id  UUID REFERENCES public.sms_conversations(id) ON DELETE SET NULL,

  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','routed','triage','ignored','failed')),
  -- Why it is in triage. A lead that could not be routed must say what was
  -- wrong with it — no phone, no matching workspace, region not live — because
  -- each of those needs a different person to fix it.
  triage_reason TEXT,

  -- The clock PPP actually cares about: Salesforce created it at X, we sent at
  -- Y. Stored rather than derived so speed-to-lead can be reported on without
  -- reconstructing it from message timestamps.
  sf_created_at   TIMESTAMPTZ,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_message_at TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The constraint the whole design rests on.
CREATE UNIQUE INDEX IF NOT EXISTS sf_lead_inbound_record_idx
  ON public.sf_lead_inbound (sf_record_id);

-- The claim query for the worker: oldest pending first.
CREATE INDEX IF NOT EXISTS sf_lead_inbound_pending_idx
  ON public.sf_lead_inbound (received_at) WHERE status = 'pending';

-- Triage is a queue somebody works, so it needs to be listable.
CREATE INDEX IF NOT EXISTS sf_lead_inbound_triage_idx
  ON public.sf_lead_inbound (received_at DESC) WHERE status = 'triage';

ALTER TABLE public.sf_lead_inbound ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sf_lead_inbound_no_client ON public.sf_lead_inbound;

-- Where the poll got to. A single row, so a restart does not re-sweep the
-- whole day or, worse, skip the window it was in the middle of.
CREATE TABLE IF NOT EXISTS public.sf_poll_state (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_found INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.sf_poll_state (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.sf_poll_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sf_poll_state_no_client ON public.sf_poll_state;

COMMENT ON TABLE public.sf_lead_inbound IS
  'Leads from Salesforce, by push (Flow webhook) AND poll (cron). Both run — sf_record_id is unique, so arriving twice is a no-op, which lets the poll be a safety net without any risk of double-messaging. Migration 192.';
COMMENT ON COLUMN public.sf_lead_inbound.arrived_via IS
  'Makes the poll''s usefulness measurable. A run of poll rows means webhooks are being dropped, which nothing else would reveal.';
COMMENT ON COLUMN public.sf_lead_inbound.first_message_at IS
  'With sf_created_at, this is speed-to-lead. Hatch takes 15 minutes to notice a lead; the target here is a message inside one.';
