-- 142 — a finish schedule belongs in the close-out package.
--
-- Stephanie 2026-08-13: "Closeout & Warranty > Don't need Certificate of
-- Insurance, drawings, manuals. Add finish schedule."
--
-- The COI half was already done: Katie had it removed from the seeded
-- checklist because a Certificate of Insurance is a PRE-construction document
-- — the GC holds it before anyone sets foot on site — so every package opened
-- with a row that had been satisfied months earlier. Same conclusion, arrived
-- at twice.
--
-- What is new is the finish schedule: for a painting contractor it IS the
-- close-out record. Which product, which colour, which sheen, in which room —
-- it is what the building owner needs two years later to touch up a wall, and
-- what Tomco's own work order is built around (the work order and the room
-- finish schedule are the same document).
--
-- As-builts and O&M manuals stop being SEEDED, since a painter produces
-- neither on a normal job, but stay ADDABLE — occasionally a GC's close-out
-- spec demands product data, and removing the capability to satisfy a
-- contractual requirement is worse than an extra row somebody marks N/A.
--
-- The CHECK is widened here because it is the second home of this list, and
-- TypeScript cannot see it. Migration 136 exists because exactly that gap let
-- three of four new roles be offered on screen and rejected at save time.

ALTER TABLE public.commercial_closeout_items
  DROP CONSTRAINT IF EXISTS commercial_closeout_items_kind_check;

ALTER TABLE public.commercial_closeout_items
  ADD CONSTRAINT commercial_closeout_items_kind_check CHECK (kind IN (
    'as_built', 'om_manual', 'warranty', 'lien_waiver',
    'final_invoice', 'punchlist_signoff', 'coi',
    'finish_schedule',
    'other'
  ));
