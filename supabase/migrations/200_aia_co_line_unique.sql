-- 200 · The change-order row that could never be inserted.
--
-- Stephanie 2026-09-11: "Change orders aren't showing up if approved after the
-- draft is generated."
--
-- `reconcileDraftChangeOrderRows` appends approved change orders to a draft's
-- schedule of values with:
--
--   .upsert(rows, { onConflict: "application_id,change_order_id",
--                   ignoreDuplicates: true })
--
-- ON CONFLICT needs a unique index covering exactly those columns, and there
-- has never been one. Every insert failed with
--
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- ...into a console.error. The reconcile reported success, the page rendered
-- fine, and the change order simply never reached the G703 — while G702 line 2
-- counted it, so the certificate did not foot. Caught by exporting nine real
-- applications and adding up each one's two sheets; no source check saw it,
-- because the code is correct and the schema it assumed was missing.
--
-- Partial, because `change_order_id` is NULL on the Original Contract line and
-- on the legacy TAX row, and several of those legitimately coexist.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_aia_line_items_app_co_uniq
  ON commercial_aia_line_items (application_id, change_order_id)
  WHERE change_order_id IS NOT NULL;
