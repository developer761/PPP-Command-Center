-- A deleted change order gives its number back.
--
-- Found by scripts/check-soft-delete-uniques.mjs, written after Stephanie hit
-- the identical thing on AIA applications the same morning:
--
--   "I deleted the AIA draft #1. Now trying to redraft AIA #1 and it is
--    telling me I can't use #1 because it is reserved to a deleted AIA."
--
-- `commercial_change_orders` has the same shape: `UNIQUE (opportunity_id,
-- co_number)` from migration 080, no `deleted_at` filter, so a soft-deleted
-- CO-002 keeps its number for ever.
--
-- Nobody has reported it because the CODE works around it — createChangeOrder
-- deliberately computes max+1 over ALL rows including deleted ones, with a
-- comment saying why. So it does not error. It burns the number instead:
-- delete CO-002, raise another, and it is called CO-003 with no 002 on the
-- job. On a document a GC files by number, a gap nobody can explain is its own
-- small problem, and "I deleted it and it came back with the wrong number" is
-- exactly the complaint we have now had twice.
--
-- A partial unique index fixes both halves: live change orders still cannot
-- share a number — the rule that actually matters — and a deleted one reserves
-- nothing, so the next CO fills the gap.
--
-- SAFE ON THIS SCHEMA: nothing upserts on this constraint. The change-order
-- module's only ON CONFLICT is on commercial_invoice_line_items
-- (application_id, change_order_id). Checked before writing this.

alter table public.commercial_change_orders
  drop constraint if exists commercial_change_orders_opportunity_id_co_number_key;

create unique index if not exists commercial_change_orders_live_number_uidx
  on public.commercial_change_orders (opportunity_id, co_number)
  where deleted_at is null;

comment on index public.commercial_change_orders_live_number_uidx is
  'Two LIVE change orders on one job cannot share a number. A deleted one releases its number so the next CO fills the gap instead of skipping it. 2026-09-24.';
