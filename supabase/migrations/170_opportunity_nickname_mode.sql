-- 170 — Project nickname: append to the name, or replace it.
--
-- Brendan 2026-08-26: "the project nickname should go at the end of the
-- opportunity title, and we should be able to toggle that."
--
-- Until now a nickname REPLACED the whole composed name, so the moment somebody
-- typed "Building C" the deal stopped showing its date, its GC and its address
-- everywhere in the platform — the three things people scan a pipeline by. What
-- Brendan wants is the nickname ON TOP of that, not instead of it.
--
-- The default is 'append' because that is the behaviour he asked for on every
-- deal made from here on. Existing rows that ALREADY carry a nickname are set
-- back to 'replace' immediately below: those deals are named what they are
-- named today, and flipping the meaning of a column under live data would
-- silently rename every one of them on the next page load.
ALTER TABLE commercial_opportunities
  ADD COLUMN IF NOT EXISTS title_override_mode text NOT NULL DEFAULT 'append';

ALTER TABLE commercial_opportunities
  DROP CONSTRAINT IF EXISTS commercial_opportunities_title_override_mode_check;

ALTER TABLE commercial_opportunities
  ADD CONSTRAINT commercial_opportunities_title_override_mode_check
  CHECK (title_override_mode IN ('append', 'replace'));

-- Preserve what every existing named deal shows today.
UPDATE commercial_opportunities
   SET title_override_mode = 'replace'
 WHERE title_override IS NOT NULL
   AND btrim(title_override) <> '';

COMMENT ON COLUMN commercial_opportunities.title_override_mode IS
  'append = nickname is added to the end of the composed name; replace = nickname IS the name. Default append (Brendan 2026-08-26).';
