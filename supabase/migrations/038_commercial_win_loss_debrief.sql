-- Migration 038 — Win/Loss Debrief feature (Commercial CC)
--
-- Three new tables + one column on opportunities to track whether a
-- terminal-state opp has been debriefed yet:
--
--  1. commercial_account_notes — sibling to commercial_opportunity_notes
--     but scoped to accounts. Auto-debrief notes land here so an account's
--     timeline shows every won/lost outcome historically. Mirrors the opp
--     notes schema (pinned_at + mentioned_user_ids + soft-delete + kind)
--     so the UI rendering pattern is identical.
--
--  2. commercial_win_loss_debrief — structured debrief row per opp closure.
--     One row per (opp_id, decided_at) — a re-opened-then-re-closed opp
--     gets a second debrief row, both visible. Captures competitor +
--     deciding_factor (reuses existing OPPORTUNITY_LOSS_REASONS enum) +
--     lessons_learned + internal_notes.
--
--  3. commercial_competitors — typeahead dictionary. New competitors
--     auto-insert on debrief submit; admins can merge/retire duplicates
--     via a Settings hub card.
--
--  4. commercial_opportunities.win_loss_debriefed_at — derived flag so
--     the amber "Debrief needed" banner query is fast (no JOIN to debrief
--     table on every opp page load). Set when the debrief row is written,
--     cleared on status flip out of terminal.
--
-- Paste-in safe: every CREATE / ALTER uses IF NOT EXISTS.

-- ============================================================
-- 1. commercial_account_notes
-- ============================================================
CREATE TABLE IF NOT EXISTS public.commercial_account_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE CASCADE,

  body TEXT NOT NULL CHECK (length(body) > 0),

  -- 'user' = typed by a person, 'auto_debrief' = system-posted when an opp
  -- closed. UI renders auto_debrief with a distinct visual (slate badge,
  -- no edit/delete buttons, links back to the source opp).
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'auto_debrief')),

  -- Source opp for auto_debrief notes — lets the UI render "View opportunity"
  -- link and lets the enrichment update (two-stage post) find the right row.
  source_opportunity_id UUID REFERENCES public.commercial_opportunities(id) ON DELETE SET NULL,

  author_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Same pinned + mentions shape as opp notes — keeps the UI component reusable.
  pinned_at TIMESTAMPTZ,
  mentioned_user_ids TEXT[] NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS commercial_account_notes_acct_idx
  ON public.commercial_account_notes (account_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS commercial_account_notes_pinned_idx
  ON public.commercial_account_notes (account_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS commercial_account_notes_mentions_idx
  ON public.commercial_account_notes USING GIN (mentioned_user_ids);

-- Lookup for "find the auto-debrief note for opp X so we can enrich it"
-- during the two-stage debrief post. Partial: only auto-debrief rows.
CREATE INDEX IF NOT EXISTS commercial_account_notes_source_opp_idx
  ON public.commercial_account_notes (source_opportunity_id)
  WHERE kind = 'auto_debrief' AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS commercial_account_notes_set_updated_at
  ON public.commercial_account_notes;
CREATE TRIGGER commercial_account_notes_set_updated_at
  BEFORE UPDATE ON public.commercial_account_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

COMMENT ON COLUMN public.commercial_account_notes.kind IS
  'user = typed by a person, auto_debrief = system-posted on opp closure.';
COMMENT ON COLUMN public.commercial_account_notes.source_opportunity_id IS
  'Set when kind=auto_debrief — points back to the opp whose closure triggered this note.';

-- ============================================================
-- 2. commercial_competitors (typeahead dictionary)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.commercial_competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Display name (title-cased). Created via the debrief modal's typeahead
  -- (admins can add inline) or via the admin Competitors management page.
  name TEXT NOT NULL CHECK (length(name) > 0),

  -- Normalized lookup key (lowercase + trimmed). UNIQUE so the typeahead
  -- can dedupe variations ("ABC Painting" / "abc painters" / "A.B.C.").
  name_normalized TEXT NOT NULL,

  -- Track + retire — if a competitor goes out of business / gets merged
  -- into another, mark inactive instead of deleting (preserves historic
  -- debrief refs).
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  -- Audit trail.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Merge tombstone — if competitor was merged INTO another, this points at
  -- the survivor. Debrief queries follow this chain so historic refs roll
  -- up correctly into the merged-into entity.
  merged_into_competitor_id UUID REFERENCES public.commercial_competitors(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS commercial_competitors_normalized_uniq
  ON public.commercial_competitors (name_normalized);

CREATE INDEX IF NOT EXISTS commercial_competitors_active_idx
  ON public.commercial_competitors (is_active, name)
  WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS commercial_competitors_set_updated_at
  ON public.commercial_competitors;
CREATE TRIGGER commercial_competitors_set_updated_at
  BEFORE UPDATE ON public.commercial_competitors
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

-- ============================================================
-- 3. commercial_win_loss_debrief
-- ============================================================
CREATE TABLE IF NOT EXISTS public.commercial_win_loss_debrief (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,

  -- Mirrors the opp's status at debrief time. Stored here so reports can
  -- bucket without joining the opp table for every row + so a re-opened
  -- opp that gets re-closed shows BOTH old + new debriefs with clear
  -- attribution.
  outcome TEXT NOT NULL CHECK (outcome IN ('won', 'lost', 'no_bid')),

  -- FK to competitors table. Nullable because won deals may not name a
  -- competitor (we didn't beat anyone specific) + no_bid deals (we passed)
  -- don't have a competitor concept.
  competitor_id UUID REFERENCES public.commercial_competitors(id) ON DELETE SET NULL,

  -- Aligned to OPPORTUNITY_LOSS_REASONS in lib/commercial/opportunities/constants.ts.
  -- For won deals, reuses the same enum to capture "what sealed it"
  -- (price = we beat them on price; scope = scope fit; etc).
  deciding_factor TEXT CHECK (deciding_factor IN (
    'price', 'scope', 'timing', 'no_decision',
    'awarded_to_competitor', 'relationship', 'other'
  )),

  -- "What would we do differently?" — free text, the quarterly review fuel.
  lessons_learned TEXT,

  -- Anything else not captured above.
  internal_notes TEXT,

  -- Who debriefed + when. Salesperson on the opp gets the bell + email.
  debriefed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  debriefed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- FK to the status-log row that triggered this debrief. Lets reports
  -- show "this debrief was for the Aug 14 closure, the Sep 2 closure has
  -- its own debrief."
  status_log_id UUID REFERENCES public.commercial_opportunity_status_log(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-opp lookup for "show all debriefs for this opp" (Timeline tab).
CREATE INDEX IF NOT EXISTS commercial_win_loss_debrief_opp_idx
  ON public.commercial_win_loss_debrief (opportunity_id, debriefed_at DESC);

-- Reports query: "all lost-to-ABC-Painting in Q3" — scoped by competitor.
CREATE INDEX IF NOT EXISTS commercial_win_loss_debrief_competitor_idx
  ON public.commercial_win_loss_debrief (competitor_id, outcome, debriefed_at DESC)
  WHERE competitor_id IS NOT NULL;

-- Reports query: outcome + date-range aggregations.
CREATE INDEX IF NOT EXISTS commercial_win_loss_debrief_outcome_date_idx
  ON public.commercial_win_loss_debrief (outcome, debriefed_at DESC);

DROP TRIGGER IF EXISTS commercial_win_loss_debrief_set_updated_at
  ON public.commercial_win_loss_debrief;
CREATE TRIGGER commercial_win_loss_debrief_set_updated_at
  BEFORE UPDATE ON public.commercial_win_loss_debrief
  FOR EACH ROW EXECUTE FUNCTION public.tg_commercial_set_updated_at();

-- ============================================================
-- 4. commercial_opportunities.win_loss_debriefed_at
-- ============================================================
-- Derived flag for the amber "Debrief needed" banner query. Cheaper than
-- LEFT JOIN to debrief table on every opp page load. Maintained by the
-- debrief-write code path:
--   - Set to NOW() when a debrief row is created for the current closure
--   - Cleared to NULL when the opp flips OUT of terminal (re-opened)
ALTER TABLE public.commercial_opportunities
  ADD COLUMN IF NOT EXISTS win_loss_debriefed_at TIMESTAMPTZ;

-- Index for the dashboard "X opps need debrief" widget. Partial: only
-- terminal-state opps without a debrief.
CREATE INDEX IF NOT EXISTS commercial_opportunities_needs_debrief_idx
  ON public.commercial_opportunities (current_status, decided_at DESC)
  WHERE current_status IN ('won', 'lost', 'no_bid')
    AND win_loss_debriefed_at IS NULL
    AND deleted_at IS NULL;

COMMENT ON COLUMN public.commercial_opportunities.win_loss_debriefed_at IS
  'When the Win/Loss Debrief was completed for the current closure. NULL = needs debrief (drives amber banner). Cleared on reopen.';
