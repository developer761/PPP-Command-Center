-- A deleted AIA draft gives its number back.
--
-- Stephanie 2026-09-24: "I started generating an AIA for building 2 and then
-- remembered I had to go back and change the sales tax setting for the correct
-- contract price to come through, so I deleted the AIA draft #1. Now trying to
-- redraft AIA #1 and it is telling me I can't use #1 because it is reserved to
-- a deleted AIA."
--
-- She is right and the database was wrong. `UNIQUE (opportunity_id,
-- application_number)` from migration 081 has no `deleted_at` filter, so a
-- soft-deleted draft keeps its number for ever. Deleting a draft and starting
-- it again — which is the ordinary way to fix a mistake before anything is
-- sent — was therefore impossible.
--
-- This morning's fix only made the refusal HONEST ("reserved to a deleted
-- AIA") instead of a raw Postgres error. Explaining a wall is not removing it:
-- the number should simply be free.
--
-- A partial unique index is the fix. Live applications still cannot share a
-- number — which is the rule that matters, because the number is how the GC
-- files the certificate — and a deleted one stops reserving anything.
--
-- SAFE ON THIS SCHEMA: nothing upserts on this constraint (the only
-- `onConflict` in the AIA module is on the line-items table, keyed
-- application_id,change_order_id), so dropping the named constraint cannot
-- break an ON CONFLICT clause. Checked before writing this.

alter table public.commercial_aia_applications
  drop constraint if exists commercial_aia_applications_opportunity_id_application_number_key;

-- Partial: only LIVE applications are constrained.
create unique index if not exists commercial_aia_applications_live_number_uidx
  on public.commercial_aia_applications (opportunity_id, application_number)
  where deleted_at is null;

comment on index public.commercial_aia_applications_live_number_uidx is
  'Two LIVE applications on one job cannot share a number. A soft-deleted one releases its number so a draft can be deleted and started again. Stephanie 2026-09-24.';
