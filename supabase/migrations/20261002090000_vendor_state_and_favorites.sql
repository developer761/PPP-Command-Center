-- Vendor state + per-user favorites, for ordering from the right branch.
--
-- Katie, 2026-10-01: "Vendor list -- ensure it's filtering to show a user's
-- favorited vendors and FL vendors if the user is a FL user, NJ if they're
-- from NJ, etc."
--
-- Neither existed. supplier_settings had no state/region column of any kind,
-- and there was no favorites concept anywhere in the app (the only `favorited_at`
-- in the schema belongs to commercial_documents).
--
-- TWO DELIBERATE DEPARTURES from the request, both argued in the thread:
--
-- 1. The list SORTS, it does not hide. Of 14 vendors, 3 have no usable state
--    even after the backfill below, and a vendor that silently disappears from
--    the picker is somebody unable to order. Favorites first, then the job's
--    state, then everyone else — all still searchable.
--
-- 2. "In state" is matched against the JOB's state (Account.BillingState,
--    already loaded on the order page), not the signed-in user's. There is no
--    state on `profiles` to match against, and the rule is better anyway: paint
--    is bought near the site, so a Long Island rep ordering the Miami job
--    should see Stein Paint, not Aboffs.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.supplier_settings
  ADD COLUMN IF NOT EXISTS state TEXT;

COMMENT ON COLUMN public.supplier_settings.state IS
  'Two-letter US state of the vendor''s branch, e.g. NY / NJ / FL. NULL = unknown; such a vendor still appears in the picker, just not in the in-state group.';

-- Per USER, not global: Katie asked for "a user's favorited vendors", and the
-- existing global `sort_order` already covers org-wide ordering.
CREATE TABLE IF NOT EXISTS public.supplier_favorites (
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_account_id TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, supplier_account_id)
);

CREATE INDEX IF NOT EXISTS supplier_favorites_user_idx
  ON public.supplier_favorites (user_id);

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Read from each vendor's own pickup address, which is where the only state
-- information in this table has been living as free text. 11 of 14 resolve.
--
-- NOT backfilled, and NOT guessed:
--   · Eco Wall Coatings      "14291 SW 120th St Suite 110"  — no state in the string
--   · Sunbelt Rentals        "3665 Expressway Dr North"     — no state in the string
--   · Paints by George       no pickup address at all
-- Both of the first two look inferable from the street grid, and inferring a
-- vendor's state from a street name is how an order goes to the wrong branch.
-- Katie sets these three in Settings → Suppliers.
UPDATE public.supplier_settings s
SET state = m.st
FROM (
  SELECT supplier_account_id,
         (regexp_match(pickup_locations->0->>'address', '\b([A-Z]{2})\s+\d{5}(-\d{4})?\s*$'))[1] AS st
  FROM public.supplier_settings
  WHERE pickup_locations->0->>'address' IS NOT NULL
) m
WHERE s.supplier_account_id = m.supplier_account_id
  AND m.st IS NOT NULL
  AND s.state IS NULL;
