-- REUSABLE REPLIES FOR A PERSON ANSWERING A THREAD. Hatch parity.
--
-- Hatch carries a named library a rep drops into a reply: "Generic Post
-- Contact Followup", "Availability", "Estimate Confirmation - In Person",
-- "Project Details", "Circling Back #1-#2". Ours has none, so somebody who
-- takes a conversation over retypes the same four sentences all day and each
-- retyping is a chance to word it differently.
--
-- ── HOW THIS DIFFERS FROM sms_workspace_faqs, WHICH IT RESEMBLES ────────
--
-- An FAQ answer is BOT-facing: the model is handed it and may repeat it
-- unsupervised, which is why those are checked for prices (A1) and for naming
-- another company (A18), and why a location-bound answer cannot be shared.
--
-- A snippet is HUMAN-facing. It is inserted into a composer, read by the
-- person sending it, and edited before it goes. A wrong snippet is caught by
-- the reader; a wrong FAQ is not caught by anybody. So the content rules here
-- are deliberately lighter, and the checks that remain are the ones a person
-- cannot catch by reading:
--
--   an unfillable merge field  -- the gate refuses the send, and the refusal
--                                 arrives after they have hit send, not while
--                                 they are looking at the words
--
-- The gate is unchanged and still the only path out. Nothing here can widen
-- quiet hours, skip the opt-out check, or raise the daily cap.
--
-- ── THE TIER, WHICH IS THE ONE FROM 20260929120000 ──────────────────────
--
-- NULL workspace_id means every workspace. Hatch's own list is generic --
-- "Availability", "Project Details" -- and a rep answers threads across
-- workspaces, so shared is the common case and per-workspace is the
-- exception. Same precedence: a workspace's own snippet with the same name
-- beats the shared one.

CREATE TABLE IF NOT EXISTS public.sms_snippets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = every workspace. See the tier note above.
  workspace_id UUID REFERENCES public.sms_sub_accounts(id) ON DELETE CASCADE,

  -- What the rep picks it by. Short, and shown in the picker.
  name         TEXT NOT NULL,
  -- What gets inserted. May carry merge fields; they are filled before the
  -- rep sees the text, so a raw {{customer_name}} never reaches the composer.
  body         TEXT NOT NULL,

  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT sms_snippets_not_blank
    CHECK (length(btrim(name)) > 0 AND length(btrim(body)) > 0)
);

-- ONE SNIPPET PER NAME PER WORKSPACE. Two called "Availability" saying
-- different things is a rep picking whichever sorted first and not knowing
-- there was another.
CREATE UNIQUE INDEX IF NOT EXISTS sms_snippets_one_per_name
  ON public.sms_snippets (workspace_id, lower(btrim(name)));

-- And one shared snippet per name. Postgres treats NULLs as distinct in a
-- unique index, so the index above does not cover the shared tier at all --
-- the same hole the shared FAQ migration had to close separately.
CREATE UNIQUE INDEX IF NOT EXISTS sms_snippets_one_shared_per_name
  ON public.sms_snippets (lower(btrim(name)))
  WHERE workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS sms_snippets_active_idx
  ON public.sms_snippets (sort_order, name) WHERE is_active;

ALTER TABLE public.sms_snippets ENABLE ROW LEVEL SECURITY;
-- Server-side only, the same shape as every other messaging table: a row
-- writable from the browser is a sentence sent to a customer as PPP, authored
-- by whoever can reach the endpoint. RLS on with no policy denies anon and
-- authenticated outright; server code uses the service role.
DROP POLICY IF EXISTS sms_snippets_no_client ON public.sms_snippets;

COMMENT ON TABLE public.sms_snippets IS
  'Reusable replies a person drops into a thread. HUMAN-facing, unlike '
  'sms_workspace_faqs which is bot-facing — a rep reads a snippet before '
  'sending it, so the content rules are lighter. Merge fields are filled '
  'before insertion so an unfillable one is caught while somebody is looking '
  'at the words rather than by the gate after they hit send. NULL '
  'workspace_id means every workspace.';
