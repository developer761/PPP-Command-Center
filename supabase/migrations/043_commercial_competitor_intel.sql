-- Migration 043: Competitor intel fields
--
-- Karan 2026-07-09: the Competitor settings page was "who's beating us"
-- driven entirely by Win/Loss debrief data — with zero debriefs on a
-- fresh install the page is a blank dictionary editor and reads as
-- pointless. Adding admin-editable intel fields (website, home base,
-- typical bid range, strengths/weaknesses, general notes) so the page
-- has real content immediately + becomes a curated intelligence brief
-- Alex + the reps consult before bidding.
--
-- All new columns are nullable — existing rows and the auto-create
-- flow from the Win/Loss modal continue to work unchanged.
--
-- Safe to re-run: every ALTER uses IF NOT EXISTS.

BEGIN;

ALTER TABLE public.commercial_competitors
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS home_base TEXT,
  ADD COLUMN IF NOT EXISTS typical_bid_low_cents BIGINT,
  ADD COLUMN IF NOT EXISTS typical_bid_high_cents BIGINT,
  ADD COLUMN IF NOT EXISTS strengths TEXT,
  ADD COLUMN IF NOT EXISTS weaknesses TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- Guard: home_base + strengths + weaknesses + notes are freeform but
-- cap length so a runaway paste doesn't turn a competitor row into
-- an 800KB record. Bid values stay unconstrained (bigint tolerates
-- realistic contract values well past any reasonable ceiling).
ALTER TABLE public.commercial_competitors
  DROP CONSTRAINT IF EXISTS commercial_competitors_website_len_chk;
ALTER TABLE public.commercial_competitors
  ADD CONSTRAINT commercial_competitors_website_len_chk
  CHECK (website IS NULL OR char_length(website) <= 500);

ALTER TABLE public.commercial_competitors
  DROP CONSTRAINT IF EXISTS commercial_competitors_home_base_len_chk;
ALTER TABLE public.commercial_competitors
  ADD CONSTRAINT commercial_competitors_home_base_len_chk
  CHECK (home_base IS NULL OR char_length(home_base) <= 200);

ALTER TABLE public.commercial_competitors
  DROP CONSTRAINT IF EXISTS commercial_competitors_strengths_len_chk;
ALTER TABLE public.commercial_competitors
  ADD CONSTRAINT commercial_competitors_strengths_len_chk
  CHECK (strengths IS NULL OR char_length(strengths) <= 2000);

ALTER TABLE public.commercial_competitors
  DROP CONSTRAINT IF EXISTS commercial_competitors_weaknesses_len_chk;
ALTER TABLE public.commercial_competitors
  ADD CONSTRAINT commercial_competitors_weaknesses_len_chk
  CHECK (weaknesses IS NULL OR char_length(weaknesses) <= 2000);

ALTER TABLE public.commercial_competitors
  DROP CONSTRAINT IF EXISTS commercial_competitors_notes_len_chk;
ALTER TABLE public.commercial_competitors
  ADD CONSTRAINT commercial_competitors_notes_len_chk
  CHECK (notes IS NULL OR char_length(notes) <= 4000);

COMMIT;
