-- The standing answers a workspace holds. Hatch parity gap 9.
--
-- ── WHAT IS MISSING WITHOUT IT ─────────────────────────────────────────
--
-- Hatch carries roughly 25 curated questions and answers PER WORKSPACE —
-- read on 2026-09-26: All Zips, Services/Surfaces, "Are you insured?",
-- "Do you have a minimum?", EPA, payment terms, references, warranty,
-- "what's the estimator's name", "Are you local?", "Where are you located?".
--
-- We answer from the rules and the services table only, so anything outside
-- those escalates to a person. Every one of those escalations is a question
-- somebody already wrote the answer to.
--
-- ── WHY PER WORKSPACE AND NOT ONE LIST ─────────────────────────────────
--
-- Because the answers genuinely differ by region and Hatch's do. "Where are
-- you located?" is "the greater Los Angeles and Orange County area" on CA LA
-- Leads and something else entirely in Nassau; the office is in Pasadena for
-- one and not for the other. A single list would make the bot confidently
-- wrong about geography, which is exactly the thing A2 and A6 are careful
-- about.
--
-- Nothing here inherits. A workspace with no rows simply has no standing
-- answers and behaves as it does today.
--
-- ── THESE REACH A MODEL PROMPT ─────────────────────────────────────────
--
-- Unlike sms_class_a_rule_notes, this table IS bot-facing: the whole point is
-- that the bot can answer from it. So the content is subject to the same
-- rules as anything else it says, and two in particular:
--
--   A1  never a price. An FAQ answering "how much will this cost" with a
--       number would launder a quote through the knowledge base and around
--       the validator that exists to stop exactly that.
--   A18 never point a customer at another company.
--
-- Enforced in code at save time (see lib/messaging/workspace-faq.ts), not
-- here — a CHECK constraint cannot read a sentence — but recorded here so
-- the next person knows the column is not free text.

CREATE TABLE IF NOT EXISTS public.sms_workspace_faqs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.sms_sub_accounts(id) ON DELETE CASCADE,

  -- What a customer asks, in their words. Matched by the model, not by us.
  question     TEXT NOT NULL,
  -- What the bot may say back. Bot-facing: see the note above.
  answer       TEXT NOT NULL,

  -- Switched off rather than deleted, so an answer that turns out to be
  -- wrong stops being used without losing what it said.
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  -- The order they appear in the prompt. Ties broken by question.
  sort_order   INTEGER NOT NULL DEFAULT 0,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- An empty question or answer is a row that can only confuse the model.
  CONSTRAINT sms_workspace_faqs_not_blank
    CHECK (length(btrim(question)) > 0 AND length(btrim(answer)) > 0)
);

-- ONE ANSWER PER QUESTION PER WORKSPACE.
--
-- Two rows answering "Are you insured?" differently is the failure this
-- prevents: the model picks one, nobody knows which, and the two disagree
-- forever because nothing compares them.
CREATE UNIQUE INDEX IF NOT EXISTS sms_workspace_faqs_one_per_question
  ON public.sms_workspace_faqs (workspace_id, lower(btrim(question)));

-- The prompt build: every active row for one workspace, in order.
CREATE INDEX IF NOT EXISTS sms_workspace_faqs_active_idx
  ON public.sms_workspace_faqs (workspace_id, sort_order)
  WHERE is_active;

ALTER TABLE public.sms_workspace_faqs ENABLE ROW LEVEL SECURITY;

-- Same shape as the other messaging tables: server-side only. A row that
-- could be written from the browser is a sentence the bot will say to a
-- customer, authored by whoever can reach the endpoint.
DROP POLICY IF EXISTS sms_workspace_faqs_no_client ON public.sms_workspace_faqs;

COMMENT ON TABLE public.sms_workspace_faqs IS
  'Hatch parity gap 9: the standing answers a workspace holds, roughly 25 per '
  'workspace in Hatch. BOT-FACING — every answer may reach a model prompt and '
  'be said to a customer, so it is subject to the same rules as anything else '
  'the bot says. A1 (never a price) and A18 (never name another company) are '
  'checked in code at save time; a CHECK constraint cannot read a sentence.';
