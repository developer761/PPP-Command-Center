-- When the customer told us not to text them.
--
-- A44, Kate, 2026-09-18: "A STATED CONSTRAINT MOVES THE CADENCE. If the
-- customer has said when they cannot be reached — 'I'm at work until 5',
-- 'don't text me during the day' — every follow-up shifts outside that window,
-- or to a Saturday. The constraint does not need to be repeated and IT DOES
-- NOT EXPIRE: once stated, it binds the whole cadence. A cadence that fires
-- into a window the customer already ruled out is a defect even if the
-- customer never complains."
--
-- ── WHY THIS IS A COLUMN AND NOT A LOOKBACK ─────────────────────────────
--
-- "It does not expire" is the whole reason there is a migration here. The
-- alternative is re-reading the conversation every time something is
-- scheduled, which means the constraint quietly stops binding the moment the
-- message that stated it falls out of whatever window that scan uses. Stating
-- it once has to be enough three weeks later, so it is stored once and read
-- from then on.
--
-- ── THE PROVENANCE COLUMNS ARE NOT DECORATION ───────────────────────────
--
-- A conversation whose follow-ups all arrive at 6pm looks like a bug to
-- whoever is reading the thread, and the only answer that stops somebody
-- "fixing" it is the customer's own sentence. stated_at and the message id
-- make the screen able to say "because on the 14th they said 'I'm at work
-- until 5'". A constraint nobody can explain gets deleted by the first person
-- who finds it surprising.
--
-- ── WHY HOURS AND NOT A WINDOW TYPE ─────────────────────────────────────
--
-- Two smallints in the customer's LOCAL hours, half open: [start, end). The
-- timezone is the workspace's and already lives there, so duplicating it here
-- would create two answers to the same question. A window wrapping midnight is
-- deliberately not representable — "don't text me at night" is the ordinary
-- quiet-hours rule (A36), not a stated constraint, and letting it in here
-- would put A36 in two places.
--
-- Safe to re-run.

ALTER TABLE public.sms_conversations
  ADD COLUMN IF NOT EXISTS unreachable_start_hour SMALLINT,
  ADD COLUMN IF NOT EXISTS unreachable_end_hour   SMALLINT,
  ADD COLUMN IF NOT EXISTS unreachable_stated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unreachable_message_id UUID;

-- Both hours or neither. A half-written window is worse than none: it would
-- read as a constraint everywhere it is checked while blocking nothing, so
-- the follow-ups would keep landing in the customer's workday and the column
-- sitting right there would look like the rule was already handled.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sms_conversations_unreachable_window'
  ) THEN
    ALTER TABLE public.sms_conversations
      ADD CONSTRAINT sms_conversations_unreachable_window CHECK (
        (unreachable_start_hour IS NULL AND unreachable_end_hour IS NULL)
        OR (
          unreachable_start_hour IS NOT NULL AND unreachable_end_hour IS NOT NULL
          AND unreachable_start_hour >= 0  AND unreachable_start_hour <= 23
          AND unreachable_end_hour   >= 1  AND unreachable_end_hour   <= 24
          -- Strictly increasing, so midnight cannot be wrapped and a zero
          -- width window cannot exist.
          AND unreachable_start_hour < unreachable_end_hour
        )
      );
  END IF;
END $$;

-- The message that said it. ON DELETE SET NULL rather than CASCADE: if the
-- message is ever removed the constraint still BINDS, because the customer
-- still said it. Only the ability to quote them back is lost.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sms_conversations_unreachable_message_fk'
  ) THEN
    ALTER TABLE public.sms_conversations
      ADD CONSTRAINT sms_conversations_unreachable_message_fk
      FOREIGN KEY (unreachable_message_id)
      REFERENCES public.sms_messages(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.sms_conversations.unreachable_start_hour IS
  'A44: first hour, customer local, the customer said they cannot be reached. Half open with unreachable_end_hour. Never expires.';
COMMENT ON COLUMN public.sms_conversations.unreachable_end_hour IS
  'A44: first hour they CAN be reached again. Exclusive bound.';
COMMENT ON COLUMN public.sms_conversations.unreachable_stated_at IS
  'A44: when they said it, so a screen can explain why follow-ups moved.';
COMMENT ON COLUMN public.sms_conversations.unreachable_message_id IS
  'A44: the message that said it. Quoting the customer is what stops somebody deleting a constraint they find surprising.';
