-- ROLLBACK for migrations 123 + 124. NOT a migration — do not let this run in
-- sequence. Kept here so an undo exists if either feature has to come out fast.
--
-- ⚠️ READ BEFORE RUNNING
--
-- Rolling back 123 is DESTRUCTIVE and can FAIL halfway:
--   * Dropping `scope_line_item_ids` throws away which crew was given which
--     scope. There is no way to reconstruct it — the split lives only in that
--     column. Every work order reverts to printing the whole proposal.
--   * Restoring the one-live-work-order-per-opportunity unique index will FAIL
--     with 23505 if ANY deal currently has two or more live sheets. That's the
--     normal state once the feature is used. Step 1 below voids the extras
--     first (keeping the oldest, which is the one the Field Ops job is linked
--     to) — that is a data change, so take a backup first if the sheets matter.
--
-- Rolling back 124 is safe and reversible: it only removes the crew ROLE rows
-- and narrows the CHECK back. Nobody loses a login — a crew user just becomes
-- an ordinary unrestricted commercial user again, which is why the crew role
-- must be revoked in the app first if the point of the rollback is to LOCK
-- them out rather than free them up.

-- ─────────────────────────────────────────────────────────────────────────
-- 124 — crew role (safe)
-- ─────────────────────────────────────────────────────────────────────────

-- Must delete the rows BEFORE narrowing the constraint, or the ALTER fails
-- validating existing data.
delete from public.commercial_user_roles where role = 'crew';

alter table public.commercial_user_roles
  drop constraint if exists commercial_user_roles_role_check;

alter table public.commercial_user_roles
  add constraint commercial_user_roles_role_check
  check (role in ('admin', 'estimator', 'pm', 'superintendent', 'foreman', 'office', 'field'));

-- ─────────────────────────────────────────────────────────────────────────
-- 123 — work-order scope selection (DESTRUCTIVE — see warning above)
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Void every extra live sheet, keeping the OLDEST per deal. Required before
--    the unique index can come back. Comment this out and resolve by hand if
--    you'd rather choose which sheet survives.
update public.commercial_work_orders w
   set voided_at = now()
 where w.voided_at is null
   and exists (
     select 1
       from public.commercial_work_orders k
      where k.opportunity_id = w.opportunity_id
        and k.voided_at is null
        and (k.created_at, k.id) < (w.created_at, w.id)
   );

-- 2. Put the original constraint back.
drop index if exists public.commercial_work_orders_opp_live_idx;

create unique index if not exists commercial_work_orders_one_live_per_opp
  on public.commercial_work_orders (opportunity_id)
  where voided_at is null;

-- 3. Drop the columns. THIS DISCARDS THE SCOPE SPLIT.
alter table public.commercial_work_orders
  drop column if exists scope_line_item_ids,
  drop column if exists area_label;
