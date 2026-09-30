-- A SHARED TIER FOR STANDING ANSWERS.
--
-- ── WHY THIS REVISITS A DECISION MADE TWO DAYS AGO ─────────────────────
--
-- 20260927100000_workspace_faqs.sql says, and meant it:
--
--   "Because the answers genuinely differ by region and Hatch's do. 'Where
--    are you located?' is 'the greater Los Angeles and Orange County area'
--    on CA LA Leads and something else entirely in Nassau... A single list
--    would make the bot confidently wrong about geography... Nothing here
--    inherits."
--
-- That reasoning is still correct and this migration does not overturn it.
-- What it corrects is the assumption underneath: that because SOME answers
-- are regional, ALL of them must be stored regionally.
--
-- Most are not. "Are you insured?", "Do you follow EPA lead-safe practices?",
-- "What are your payment terms?", "What does the warranty cover?" and "Do you
-- have a minimum job size?" are company policy. They are identical in Nassau
-- and Pasadena, and storing them per workspace means writing the same sentence
-- 15 or 32 times and editing it that many times whenever the policy changes.
--
-- That cost is not hypothetical and it is not ours: Kate writes this content,
-- roughly 25 answers per workspace, and she is starting now. The table is
-- empty today, which is the last moment this change costs nothing to make.
--
-- ── THE HAZARD THE ORIGINAL MIGRATION NAMED IS REAL, SO IT IS GUARDED ──
--
-- A shared "Where are you located?" would make the bot confidently wrong in
-- every region but one — precisely the A2/A6 failure the original note was
-- protecting against. So location-bound questions CANNOT be shared. That is
-- enforced in lib/messaging/workspace-faq.ts (isLocationBound), refused at
-- save time, and the refusal explains itself.
--
-- The check is deliberately over-eager. A question wrongly refused from the
-- shared tier is written per workspace, which is exactly what happens today,
-- so a false positive costs nothing new. A geographic answer wrongly shared is
-- the bot stating the wrong service area to a customer as fact. Those two are
-- not close, and the check is tuned for the second.
--
-- ── PRECEDENCE ─────────────────────────────────────────────────────────
--
-- A workspace row beats a shared row for the same question. So a shared
-- default can be overridden regionally without deleting anything, and the
-- override is visible as a row rather than implied by an absence.

-- NULL workspace_id means "every workspace". The column stays a FK, so a
-- workspace-scoped row still cannot point at a workspace that is gone.
ALTER TABLE public.sms_workspace_faqs
  ALTER COLUMN workspace_id DROP NOT NULL;

-- ONE SHARED ANSWER PER QUESTION.
--
-- sms_workspace_faqs_one_per_question does NOT cover these. Postgres treats
-- NULLs as distinct in a unique index, so (NULL, 'are you insured?') can be
-- inserted any number of times and the existing index raises nothing. Two
-- shared rows answering the same question differently is the exact failure
-- that index was written to prevent, reappearing through the hole the
-- nullable column opens.
CREATE UNIQUE INDEX IF NOT EXISTS sms_workspace_faqs_one_shared_per_question
  ON public.sms_workspace_faqs (lower(btrim(question)))
  WHERE workspace_id IS NULL;

-- The prompt build reads shared rows on every workspace's turn, and
-- sms_workspace_faqs_active_idx leads with workspace_id so it does not serve
-- them.
CREATE INDEX IF NOT EXISTS sms_workspace_faqs_shared_active_idx
  ON public.sms_workspace_faqs (sort_order, id)
  WHERE is_active AND workspace_id IS NULL;

COMMENT ON COLUMN public.sms_workspace_faqs.workspace_id IS
  'The workspace this answer belongs to, or NULL for an answer shared by every '
  'workspace. A workspace row beats a shared row for the same question. '
  'Location-bound questions are refused from the shared tier in code '
  '(lib/messaging/workspace-faq.ts, isLocationBound) because one service area '
  'stated across 15 regions is wrong in 14 of them.';
