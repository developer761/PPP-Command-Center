-- What the lead told us, kept where the conversation can read it.
--
-- ── THE GAP THIS CLOSES ─────────────────────────────────────────────────
--
-- KnownCustomer has carried `address` and `inquiryScope` since it was
-- written. validateAction branches on them, the confirm_address and
-- confirm_scope templates render them, A11 narrows the address ask from them,
-- A6 and A7 route the job from them, and A9 checks the scope for a
-- placeholder.
--
-- Nothing has ever set either one. Not the scheduler, not the simulator.
-- Traced end to end on 2026-09-23:
--
--   LEAD_FIELDS did not request Street
--     -> the parsed lead had no address to carry
--       -> sms_conversations had no column to put one in
--         -> scheduler-db passed { name, phone, email } and nothing else
--           -> kf.address and kf.inquiryScope were always null
--
-- So the rules built on them were real code that could not fire. The bot
-- asked for an address the record already held, which is A13, the second most
-- broken rule in Kate's grading at 206 breaches, and it never once routed a
-- job off-site because it never knew what the job was.
--
-- ── WHY THE COLUMNS LIVE HERE AND NOT ON THE LEAD ROW ───────────────────
--
-- sf_lead_inbound holds the raw payload, and it is keyed by the Salesforce
-- push rather than by the conversation. A reply needs one read of the
-- conversation it is replying to, and following a chain back to a lead row on
-- every turn would put a join in the reply path for data that does not
-- change. The conversation is the thing a turn already reads.
--
-- These are a SNAPSHOT of what the lead said, not a mirror of Salesforce.
-- When the customer corrects their address in the conversation, the
-- conversation is right and the lead is stale, and that is the correct way
-- round: A9 says paraphrasing exists to surface errors in the record.
--
-- Safe to re-run.

ALTER TABLE public.sms_conversations
  -- One line: street, city, state, zip. NULL when the lead had no street or
  -- no zip, because A11 defines a full address as street plus zip and half of
  -- one is not something we can read back for confirmation.
  ADD COLUMN IF NOT EXISTS customer_address TEXT,
  -- The lead's own words about the work. A9 governs what may be done with
  -- it, including the rule that a placeholder sitting in a scope field is not
  -- scope at all.
  ADD COLUMN IF NOT EXISTS inquiry_scope TEXT,
  -- Kept separate from the address line so A2 can validate it without having
  -- to parse a sentence back apart. Five digits, or nothing.
  ADD COLUMN IF NOT EXISTS customer_zip TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sms_conversations_customer_zip_shape'
  ) THEN
    ALTER TABLE public.sms_conversations
      ADD CONSTRAINT sms_conversations_customer_zip_shape
      CHECK (customer_zip IS NULL OR customer_zip ~ '^[0-9]{5}$');
  END IF;
END $$;

COMMENT ON COLUMN public.sms_conversations.customer_address IS
  'Street, city, state and zip as one line. NULL unless BOTH street and zip are known, per A11. A snapshot of what the lead said, not a mirror of Salesforce.';
COMMENT ON COLUMN public.sms_conversations.inquiry_scope IS
  'What the lead said they wanted. A9 decides what may be done with it; a placeholder here is treated as no scope at all.';
COMMENT ON COLUMN public.sms_conversations.customer_zip IS
  'Five digits, for A2 service-area validation without re-parsing the address line.';
