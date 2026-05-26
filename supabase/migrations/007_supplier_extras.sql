-- Phase 2 — Extras catalog (the 20-item dropdown)
-- ------------------------------------------------------------------
-- Materials a worker might tack onto a supplier order beyond paint:
-- rollers, brushes, painter's tape, drop cloths, sandpaper, etc.
--
-- Karan will provide the actual 20-item list once Phase 2 is shipping.
-- Until then we seed a reasonable default set so the dropdown works on
-- day 1; admin replaces / edits via /dashboard/settings/templates.
--
-- preferred_supplier_id is optional — when set, the item only appears in
-- the dropdown for orders going to that supplier (e.g., a BM-branded item).
-- When NULL, the item appears for every supplier (supplier-agnostic).
--
-- Safe to re-run via IF NOT EXISTS guards. Seeds use ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS supplier_extras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'each',     -- each / box / case / gallon / roll / etc.
  default_qty INTEGER NOT NULL DEFAULT 1,
  -- Optional scope to a specific supplier (NULL = all suppliers)
  preferred_supplier_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS supplier_extras_active_sort_idx
  ON supplier_extras (is_active, sort_order)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION supplier_extras_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS supplier_extras_touch_trigger ON supplier_extras;
CREATE TRIGGER supplier_extras_touch_trigger
  BEFORE UPDATE ON supplier_extras
  FOR EACH ROW
  EXECUTE FUNCTION supplier_extras_touch_updated_at();

-- Default seed — reasonable starter items every painter needs. Admin
-- can disable / replace via the editor once Karan sends his 20-item list.
-- Uses a deterministic synthetic UUID (md5 of the name) so re-running the
-- migration is idempotent — same name → same UUID → ON CONFLICT skips.
INSERT INTO supplier_extras (id, name, unit, default_qty, sort_order)
SELECT
  ('00000000-0000-0000-0000-' || substring(md5(name) from 1 for 12))::uuid,
  name, unit, qty, sort
FROM (VALUES
  ('9" microfiber roller cover',            'each',   6,  10),
  ('9" roller frame',                       'each',   2,  20),
  ('2" angled sash brush',                  'each',   2,  30),
  ('3" flat brush',                         'each',   2,  40),
  ('4" mini roller (cabinets/trim)',        'each',   4,  50),
  ('9x12 canvas drop cloth',                'each',   3,  60),
  ('12oz painter''s tape (blue)',           'roll',   4,  70),
  ('1.5" painter''s tape (green/delicate)', 'roll',   2,  80),
  ('5-gallon plastic bucket',               'each',   2,  90),
  ('Paint tray + liners (3-pack)',          'set',    2, 100),
  ('Spackle / lightweight filler (32oz)',   'tub',    1, 110),
  ('Sanding sponge (medium grit)',          'pack',   2, 120),
  ('150-grit sandpaper (sheets)',           'pack',   1, 130),
  ('Caulk (paintable, white)',              'tube',   4, 140),
  ('Plastic sheeting (10x20)',              'roll',   1, 150),
  ('Mineral spirits / paint thinner',       'gallon', 1, 160),
  ('Latex primer (gallon)',                 'gallon', 1, 170),
  ('Oil-based primer (gallon)',             'gallon', 1, 180),
  ('Stain blocker (spot primer)',           'each',   1, 190),
  ('Disposable gloves (box of 100)',        'box',    1, 200)
) AS seed(name, unit, qty, sort)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE supplier_extras IS
  'Catalog of non-paint extras (rollers / brushes / tape / etc.) for the worker dropdown in the supplier order modal. Editable via /dashboard/settings/templates.';
