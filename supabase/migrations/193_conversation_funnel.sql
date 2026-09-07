-- Migration 193: where conversations actually die, and why humans take over.
--
-- Hatch reports Active, Completed, Success%, DropOff% and TakeOver% per
-- workspace. Useful, and PPP's own numbers show the limit of it:
--
--     NY NYC Leads    15 completed   0% success   26.7% takeover
--     CO Denver        8 completed  37.5% success  25.0% takeover
--
-- Same bot, same campaign, wildly different results — and nothing in Hatch says
-- why, so nobody can act on it. Two columns fix that.
--
-- QUALIFICATION_STAGE. Emily's required flow is an ordered funnel:
-- Project Details -> Full Address -> Contact Information -> Appointment
-- Availability. Recording how far each conversation got turns "0% success"
-- into "they answer the project question and vanish at the address", which is
-- a thing somebody can rewrite. A single success rate cannot tell those apart.
--
-- TAKEOVER_REASON. A human stepping in is the bot admitting it could not cope.
-- Hatch counts those and discards the reason, so a 26.7% takeover rate is a
-- number rather than a to-do list. Captured at the moment it happens, while
-- whoever took over still knows why.
--
-- Safe to re-run.

ALTER TABLE public.sms_conversations
  -- Ordered so it can be compared: a conversation only ever moves forward.
  ADD COLUMN IF NOT EXISTS qualification_stage SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS takeover_reason TEXT,
  ADD COLUMN IF NOT EXISTS takeover_at TIMESTAMPTZ,
  -- First outbound. With sf_lead_inbound.sf_created_at this is speed-to-lead,
  -- and it lives here too so a conversation can be measured on its own.
  ADD COLUMN IF NOT EXISTS first_outbound_at TIMESTAMPTZ,
  -- First inbound. The gap between them is how long the customer took to
  -- reply, which is a different number from how long WE took.
  ADD COLUMN IF NOT EXISTS first_inbound_at TIMESTAMPTZ;

-- 0 none · 1 project details · 2 address · 3 contact · 4 availability.
-- Numeric rather than an enum precisely so "got further than" is a comparison
-- rather than a lookup table.
ALTER TABLE public.sms_conversations DROP CONSTRAINT IF EXISTS sms_conversations_stage_chk;
ALTER TABLE public.sms_conversations
  ADD CONSTRAINT sms_conversations_stage_chk CHECK (qualification_stage BETWEEN 0 AND 4);

-- Why a human stepped in. A closed list, because free text becomes 200 unique
-- reasons nobody can count. 'other' exists with a note rather than pretending
-- the list is complete.
ALTER TABLE public.sms_conversations DROP CONSTRAINT IF EXISTS sms_conversations_takeover_chk;
ALTER TABLE public.sms_conversations
  ADD CONSTRAINT sms_conversations_takeover_chk CHECK (
    takeover_reason IS NULL OR takeover_reason IN (
      'low_confidence',        -- the bot was unsure and escalated itself
      'customer_asked_human',  -- "call me", "is this a bot"
      'out_of_scope',          -- work PPP does not do
      'complaint',             -- something negative was said
      'pricing_pressure',      -- pushed for a number the bot may not give
      'language',              -- not English. Today Hatch just transfers.
      'repeated_confusion',    -- the bot asked the same thing twice
      'media_received',        -- a photo the bot cannot act on
      'manual_review',         -- draft-for-review, a person sending
      'other'
    )
  );

-- Reporting reads by workspace and time, constantly.
CREATE INDEX IF NOT EXISTS sms_conversations_reporting_idx
  ON public.sms_conversations (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_conversations_takeover_idx
  ON public.sms_conversations (takeover_reason) WHERE takeover_reason IS NOT NULL;

COMMENT ON COLUMN public.sms_conversations.qualification_stage IS
  'How far through Emily''s required flow this conversation got. 0 none, 1 project details, 2 address, 3 contact, 4 availability. Turns a success rate into a funnel: "0% success" and "they all vanish at the address question" are the same number and different problems. Migration 193.';
COMMENT ON COLUMN public.sms_conversations.takeover_reason IS
  'Why a human stepped in. Hatch counts takeovers and discards the reason, so 26.7% is a number rather than a to-do list.';
